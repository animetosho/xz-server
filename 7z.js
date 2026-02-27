/**
 * xz to 7z conversion
 * xz based off v1.0.4 specification
 */
"use strict";

function decodeVarInt(buf, offset) {
	var value = 0, length = 0;
	do {
		value |= (buf[offset] & 0x7F) << (length*7);
		length++;
		if(length >= 9) break;
	} while(buf[offset++] & 0x80);
	
	return [value, length];
}

function parse_xz(buf, bufEnd) {
	// TODO: buffer length checks
	var ret = {};
	// magic
	if(buf.slice(0, 6).toString('hex') != "fd377a585a00")
		throw new Error("Invalid header magic");
	// version
	if(buf[6] != 0)
		throw new Error("Unsupported xz version");
	// check type
	var checkType = buf[7];
	if(checkType != 0 && checkType != 1) // only support none/crc32
		throw new Error("Unsupported check type");
	// CRC32 - ignored
	
	
	if(buf[12] == 0) {
		// no blocks in file -> this is a 0 byte file
		return {
			crc32: [0,0,0,0],
			csize: 0,
			usize: 0,
			filters: [],
			dataPos: 0
		};
	}
	
	/// decode block
	// block header size
	var bhSize = buf[12] *4 +4;
	var bFlags = buf[13];
	var bFilters = (bFlags & 0x3) +1;
	
	if(bhSize < 8)
		throw new Error("Invalid header size");
	
	var bCSize=null, bUSize=null;
	var pos = 14;
	// compressed size
	if(bFlags & 0x40) {
		bCSize = decodeVarInt(buf, pos)
		pos += bCSize[1];
		bCSize = bCSize[0];
	}
	// uncompressed size
	if(bFlags & 0x80) {
		bUSize = decodeVarInt(buf, pos)
		pos += bUSize[1];
		bUSize = bUSize[0];
	}
	
	// filter flags
	var filterProps = [];
	for(var i=0; i<bFilters; i++) {
		var filtId = decodeVarInt(buf, pos);
		pos += filtId[1];
		var filtSz = decodeVarInt(buf, pos);
		pos += filtSz[1];
		filterProps.push({
			id: filtId[0],
			props: Array.prototype.slice.call(buf.slice(pos, pos+filtSz[0]))
		});
		pos += filtSz[0];
	}
	
	// padding & sanity check
	var padBytes = bhSize - pos+8;
	if(padBytes < 0)
		throw new Error("Header size too small");
	if(padBytes > 3)
		throw new Error("Unexpected padding length: " + padBytes);
	while(padBytes-- > 0) {
		if(buf[pos++] != 0)
			throw new Error("Invalid padding byte");
	}
	
	// CRC32 check
	var crc32 = (require('buffer-crc32')).signed;
	if(crc32(buf.slice(12, pos)) != buf.readInt32LE(pos))
		throw new Error("Header corrupt - CRC32 mismatch");
	pos += 4;
	
	
	// read from end of file
	var endLen = bufEnd.length;
	if(endLen < 16)
		throw new Error("End chunk too small");
	
	// footer magic
	if(bufEnd.slice(-2).toString() != "YZ")
		throw new Error("Invalid footer magic");
	// check stream flags
	if(bufEnd.slice(-4, -2).toString('hex') != buf.slice(6, 8).toString('hex'))
		throw new Error("Header/footer stream flags mismatch");
	// check footer CRC
	if(crc32(bufEnd.slice(-8, -2)) != bufEnd.readInt32LE(endLen-12))
		throw new Error("Footer corrupt - CRC32 mismatch");
	// index size
	var indexSize = bufEnd.readUInt32LE(endLen-8)*4 +4;
	
	
	// parse index
	var index = bufEnd.slice(-(12+indexSize), -12);
	if(index[0] != 0)
		throw new Error("Invalid index indicator");
	if(index[1] != 1)
		throw new Error("Number of blocks != 1");
	
	var pos2 = 2;
	var iCSize = decodeVarInt(index, pos2)
	pos2 += iCSize[1];
	// need to subtract block headers
	iCSize = iCSize[0] - bhSize - (checkType ? 4:0);
	var iUSize = decodeVarInt(index, pos2)
	pos2 += iUSize[1];
	iUSize = iUSize[0];
	
	// padding
	var padLen = index.length - pos2 - 4;
	if(padLen < 0 || padLen > 3)
		throw new Error("Unexpected padding length for index");
	// check CRC of index
	if(crc32(index.slice(0, -4)) != index.readInt32LE(index.length-4))
		throw new Error("Index corrupt - CRC32 mismatch");
	
	// grab CRC
	var check;
	if(checkType) {
		check = bufEnd.slice(-(12+indexSize) -4).slice(0, 4);
		check = Array.prototype.slice.call(check);
	}
	
	return {
		crc32: check,
		csize: iCSize,
		usize: iUSize,
		filters: filterProps,
		dataPos: pos
	};
}


var async = require('async');
var fs = require('fs');
var _ = require('underscore');

var XZ_HEADER_PEEK = 48; // how many bytes to read for the header info
// TODO: actually read more than we probably need
var readCb = function(cb) {
	var a = _.values(arguments);
	a.shift(); // shift out cb
	return function(err, read, buf) {
		a.unshift(err);
		a.push(read);
		a.push(buf);
		cb.apply(null, a);
	};
};

// a somewhat serial pipe mechanism
var _pipeFileToStream = function(fd, pos, len, stream, buf, cb) {
	if(len > 0) {
		fs.read(fd, buf, 0, Math.min(len, 256*1024), pos, function(err, read, data) {
			if(err) return cb(err);
			if(stream.destroyed) return cb('cancelled');
			
			var cont = function() {
				_pipeFileToStream(fd, pos + read, len - read, stream, buf, cb);
			};
			if(stream.write(data.slice(0, read)))
				process.nextTick(cont);
			else
				stream.once('drain', cont);
		});
	} else
		process.nextTick(cb);
};
var pipeFileToStream = function(fd, pos, len, stream, cb) {
	_pipeFileToStream(fd, pos, len, stream, Buffer.alloc(256*1024), cb);
};

// open & read xz info
var readXzInfo = function(file, fSize, xzBuf, xzBuf2, callback) {
	var fd;
	async.waterfall([
		// read a bit of the xz file
		function(cb) {
			fs.open(file, 'r', cb);
		},
		function(fp, cb) {
			fd = fp;
			async.series([
				// from the start
				function(cb) {
					fs.read(fp, xzBuf, 0, XZ_HEADER_PEEK, 0, function(err, size) {
						cb(err, size);
					});
				},
				// from the end
				function(cb) {
					fs.read(fd, xzBuf2, 0, XZ_HEADER_PEEK, Math.max(0, fSize-XZ_HEADER_PEEK), function(err, size) {
						cb(err, size);
					});
				}
			], cb);
		},
		// go thru read info
		function(bytesRead, cb) {
			/*
			// TODO: fix these
			if(bytesRead[0] < XZ_HEADER_PEEK)
				cb(new Error('Could not read enough of the XZ file'));
			if(bytesRead[1] < XZ_HEADER_PEEK)
				cb(new Error('Could not read enough of the XZ file'));
			*/
			
			var xzInfo;
			try {
				xzInfo = parse_xz(xzBuf.slice(0, bytesRead[0]), xzBuf2.slice(0, bytesRead[1]));
			} catch(err) {
				return cb(err);
			}
			
			cb(null, xzInfo);
		}
	], function(err, xzInfo) {
		callback(err, xzInfo, fd);
	});
}

// reads some xz files for caching
// files should be an array/object of [filename, filesize]
exports.cacheFileInfo = function(files, callback) {
	var files7z = (files instanceof Array ? [] : {});
	var xzBuf = Buffer.alloc(XZ_HEADER_PEEK);
	var xzBuf2 = Buffer.alloc(XZ_HEADER_PEEK);
	
	// convert the files array/object into an array that eachSeries likes
	var files2 = [];
	for(var i in files) {
		files2.push([i, files[i][0], files[i][1]]);
	}
	
	async.eachSeries(files2, function(file, fileCb) {
		var fd = null;
		var xzInfo;
		var fSize = file[2];
		
		readXzInfo(file[1], fSize, xzBuf, xzBuf2, function(err, xzInfo, fp) {
			if(fp) fs.close(fp, function(){});
			if(!err)
				files7z[file[0]] = xzInfo;
			else
				err = new Error('Error in ' + file[1] + ': ' + err.message);
			return fileCb(err);
		});
	}, function(err) {
		if(err) {
			callback(err);
		}
		else {
			/*gen7zFooter(files7z, function(err, encHeader, postHeader) {
				if(err) {
					callback(err);
				} else {
					// TODO: calc hash for footer etc
					callback(null, files7z);
				}
			});*/
			callback(null, files7z);
		}
		
	});
};

// files is array of [file, size, display filename]
exports.combineTo7z = function(files, req, resp) {
	// TODO: support multi-part downloading??
	
	// output 7z header
	resp.write(Buffer.from('377ABCAF271C0002' + '000000000000000000000000000000000000000000000000', 'hex'));
	
	var files7z = [];
	var xzBuf = Buffer.alloc(XZ_HEADER_PEEK);
	var xzBuf2 = Buffer.alloc(XZ_HEADER_PEEK);
	
	// output xz streams
	// TODO: handle case of cancelled transfer
	async.eachSeries(files, function(file, fileCb) {
		var fd = null;
		var xzInfo;
		var fSize = file[1];
		async.waterfall([
			function(cb) {
				readXzInfo(file[0], fSize, xzBuf, xzBuf2, cb);
			},
			function(xzi, fp, cb) {
				fd = fp;
				xzInfo = xzi;
				pipeFileToStream(fd, xzInfo.dataPos, xzInfo.csize, resp.connection, cb);
			},
		], function(err) {
			if(fd) fs.close(fd, function(){});
			if(!err) {
				xzInfo.name = file[2];
				files7z.push(xzInfo);
			}
			fileCb(err);
		});
	}, function(err) {
		if(err === 'cancelled') {
			log.info('Transfer aborted (during piping)');
			resp.end();
			return;
		}
		if(err) {
			log.error('combineTo7z error: ', err);
			// TODO: throw error to client if possible?
			resp.end();
		}
		else {
			// output & end with footer
			gen7zFooter(files7z, function(err, encHeader, postHeader) {
				if(err) log.error('gen7zFooter error: ', err);
				else {
					resp.write(encHeader);
					resp.write(postHeader);
				}
				resp.end();
			});
		}
		
	});
};

// returns the CRC32 as a buffer
var crc32buffer = function(d) {
	return Buffer.from(Array.prototype.slice.call((require('buffer-crc32'))(d)).reverse());
};

exports.combineTo7zCached = function(files, req, resp) {
	// TODO: support multi-part downloading??
	
	var noHc = !!req.url.match(/[?&]hc=off($|&)/); // for debugging - disable header compression
	
	gen7zFooter(files, function(err, encHeader, postHeader) {
		if(err) {
			log.error('gen7zFooter error: ', err);
			return;
		}
		
		var contentLength = files.reduce(function(a, v) {
			return a + v.csize;
		}, 0);
		var headerLen = encHeader.length + postHeader.length;
		var activeHeader = postHeader || encHeader;
		var totalLength = 32 + contentLength + headerLen;
		//resp.setHeader('Content-Range', 'bytes 0-' + (totalLength-1) + '/' + totalLength);
		
		var offset = 0, sendLength = totalLength;
		var responseCode = 200;
		
		/*
		resp.setHeader('Accept-Ranges', 'bytes');
		resp.setHeader('Vary', 'Range');
		if(req.headers.range) {
			var range = (require('range-parser'))(totalLength, req.headers.range);
			if(range.type == 'bytes') {
				// we only consider the first range
				resp.setHeader('Content-Range', 'bytes ' + range[0].start + '-' + range[0].end + '/' + totalLength);
				offset = range[0].start;
				sendLength = range[0].end - range[0].start;
				responseCode = 206;
			}
		}
		*/
		resp.setHeader('Content-Length', sendLength);
		
		var etag = require('crypto').createHash('md5').update(encHeader).digest('hex');
		resp.setHeader('ETag', etag);
		// TODO: support If-None-Match header
		
		resp.writeHead(responseCode);
		if(req.method == 'HEAD' || sendLength < 1) {
			resp.end();
			return;
		}
		
		// output 7z header
		if(offset < 32) {
			resp.write(Buffer.from('377ABCAF271C0002', 'hex'));
			var sigHeader = Buffer.from('00000000000000000000000000000000', 'hex');
			sigHeader.writeUInt32LE(contentLength + (postHeader ? encHeader.length : 0), 0);
			sigHeader.writeUInt32LE(activeHeader.length, 8);
			sigHeader = Buffer.concat([sigHeader, crc32buffer(activeHeader)]);
			resp.write(crc32buffer(sigHeader));
			resp.write(sigHeader);
		}
		
		if(resp.connection.destroyed) {
			log.info('Transfer aborted (before piping)');
			resp.end();
			return;
		}
		
		// output xz streams
		async.eachSeries(files, function(file, fileCb) {
			var fd = null;
			async.waterfall([
				function(cb) {
					fs.open(file.filename, 'r', cb);
				},
				function(fp, cb) {
					fd = fp;
					pipeFileToStream(fd, file.dataPos, file.csize, resp.connection, cb);
				}
			], function(err) {
				if(fd) fs.close(fd, function(){});
				fileCb(err);
			});
		}, function(err) {
			if(err === 'cancelled') {
				log.info('Transfer aborted (during piping)');
				resp.end();
				return;
			}
			
			if(err) {
				log.error('combineTo7zCached error: ', err);
				// TODO: throw error to client if possible?
				resp.end();
			}
			else {
				// output & end with footer
				resp.write(encHeader);
				resp.write(postHeader);
				resp.end();
			}
		});
	}, noHc);
};


var SIG7z = {
	END:         0x0,
	HEADER:      0x1,
	ARCPROP:     0x2, // archive properties
	ADDSTRMINFO: 0x3, // additional stream info
	STRMINFO:    0x4, // main stream info
	FILESINFO:   0x5,
	PACKINFO:    0x6,
	UNPACKINFO:  0x7,
	SUBSTRMINFO: 0x8, // substream info
	SIZE:        0x9,
	CRC:         0xA,
	FOLDER:      0xB,
	CODUNPACKSIZE: 0xC, // coders unpack size
	NUMUNPACKSTRM: 0xD, // num unpack stream
	EMPTYSTRM:   0xE,
	EMPTYFILE:   0xF,
	ANTI:       0x10,
	NAME:       0x11,
	CREATTIME:  0x12, // creation time
	LACCTIME:   0x13, // last access time
	LWRTTIME:   0x14, // last write time
	WINATTR:    0x15, // windows attributes
	COMMENT:    0x16,
	ENCHEADER:  0x17, // encoded header
};
var z7uint64 = function(v) {
	var ret = [];
	for(var i=0; i<8; i++) {
		if(v >= (0x80 >> i)) {
			// shift out bottom byte
			ret.push(v & 0xFF);
			v >>= 8;
		} else {
			// done, prepend top byte mask
			ret.unshift(((0xFF00 >> i) & 0xFF) | v);
			return ret;
		}
	}
	// all 8 bytes used
	ret.unshift(0xFF);
	return ret;
};
var convFilters = function(filters) {
	/* if(!filters.length) {
		// no filters == copy (this only occurs on the blank file)
		return [0x1, 0x0];
	} */
	var ret = [];
	filters.forEach(function(filter) {
		switch(filter.id) {
			case 0x21: // lzma2
			case 0x03: // delta
				ret.push(0x21); // DecompressionMethod.IDSize + 'has properties'
				ret.push(filter.id);
				ret.push(filter.props.length);
				ret.push(filter.props[0]);
			break;
			
			//BCJ
			case 0x04: // x86
			case 0x05: // PPC
			case 0x06: // IA64
			case 0x07: // ARM
			case 0x08: // Thumb
			case 0x09: // SPARC
				throw new Error("Jump filter not supported");
			default:
				throw new Error("Unknown filter type " + filter.id);
		}
	});
	return ret;
};
// note: ar.length > 0 is assumed
var packBits = function(ar) {
	var ret = [];
	while(ar.length) {
		var a = 0;
		for(var i=7; i>=0; i--) {
			var d = ar.shift();
			if(d === undefined) break;
			a |= d << i;
		}
		ret.push(a);
	}
	return ret;
};
// join an array with itself 'count' times, eg concatTimes([1,2], 3) => [1,2,1,2,1,2]
var concatTimes = function(arr, count) {
	if(!count) return [];
	var ret = arr.slice(), i = 1;
	// exponential concatenation
	for(; i <= (count>>1); i <<= 1)
		ret = ret.concat(ret);
	for(; i < count; i++)
		ret = ret.concat(arr);
	return ret;
};
var _gen7zFooter = function(files) {
	// need to exclude blank files
	var neFiles = [];
	var blankStrms = [], blankFiles = [];
	var containsBlank = false;
	files.forEach(function(file) {
		if(file.csize) {
			neFiles.push(file);
			blankStrms.push(0);
		} else {
			blankStrms.push(1);
			blankFiles.push(1);
			containsBlank = true;
		}
	});
	var blankDefs = [];
	if(containsBlank) {
		var strmBlank = packBits(blankStrms);
		var fileBlank = packBits(blankFiles);
		blankDefs = [SIG7z.EMPTYSTRM]
		    .concat(z7uint64(strmBlank.length))
		    .concat(strmBlank)
		    .concat([SIG7z.EMPTYFILE])
		    .concat(z7uint64(fileBlank.length))
		    .concat(fileBlank)
		;
	}
	
	var filesLen = z7uint64(neFiles.length);
	var names = _.flatten(files.map(function(file) {
		return Array.prototype.slice.call(Buffer.from(file.name + "\u0000", 'ucs2'));
	}));
	var allCRCsDefined = true;
	var definedCRCs = [];
	var crcs = _.flatten(neFiles.map(function(file) {
		if(file.crc32) {
			definedCRCs.push(1);
			return file.crc32;
		} else {
			allCRCsDefined = false;
			definedCRCs.push(0);
			return [];
		}
	}));
	if(!allCRCsDefined) {
		crcs = packBits(definedCRCs).concat(crcs);
	}
	
	//var dummyDate = [0,0,0,0,0,0,0,0], attrib = [0x20,0,0,0];
	return Buffer.from([].concat([SIG7z.HEADER,
		SIG7z.STRMINFO,
			SIG7z.PACKINFO,
				0, // UINT64 PackPos
				]).concat(filesLen).concat([ // UINT64 NumPackStreams
				SIG7z.SIZE,
				]).concat(_.flatten(neFiles.map(function(file) {
					return z7uint64(file.csize);
				}))).concat([
			SIG7z.END,
			SIG7z.UNPACKINFO,
				SIG7z.FOLDER,
				]).concat(filesLen).concat([ // UINT64 NumFolders
				0, // BYTE External
				]).concat(_.flatten(neFiles.map(function(file) {
					return z7uint64(file.filters.length) // UINT64 NumCoders
						.concat(convFilters(file.filters));
				}))).concat([
				SIG7z.CODUNPACKSIZE,
				]).concat(_.flatten(neFiles.map(function(file) {
					return z7uint64(file.usize);
				}))).concat([
			SIG7z.END,
			// TODO: if >0 files lack a CRC, we can't include this chunk
			SIG7z.SUBSTRMINFO,
				SIG7z.CRC,
				allCRCsDefined ? 1:0, // BYTE AllAreDefined
				]).concat(crcs).concat([
			SIG7z.END,
		SIG7z.END,
		SIG7z.FILESINFO,
			]).concat(z7uint64(files.length)).concat([ // UINT64 NumFiles
			]).concat(blankDefs).concat([
			
			SIG7z.NAME,
			]).concat(z7uint64(names.length +1 /*for external byte*/)).concat([ // UINT64 Size
			0, // BYTE External
			]).concat(names).concat([
			
			/*
			SIG7z.LWRTTIME,
			]).concat(z7uint64(files.length*8 +2)).concat([ // UINT64 Size
			1, // BYTE AllAreDefined
			0, // BYTE External
			]).concat(concatTimes(dummyDate, files.length)).concat([
			
			SIG7z.WINATTR,
			]).concat(z7uint64(files.length*4 +2)).concat([ // UINT64 Size
			1, // BYTE AllAreDefined
			0, // BYTE External
			]).concat(concatTimes(attrib, files.length)).concat([
			*/
			
		SIG7z.END,
	SIG7z.END]));
};
var gen7zFooter = function(files, cb, uncompressed) {
	try {
		var footer = _gen7zFooter(files);
		if(uncompressed) return cb(null, footer, '');
		require('zlib').deflateRaw(footer, function(err, data) {
			if(err) return cb(err);
			var ret = Buffer.from([].concat([
				SIG7z.ENCHEADER,
					SIG7z.PACKINFO,
						]).concat(z7uint64(_.reduce(files, function(a, file) {
							return a + file.csize;
						}, 0))).concat([ // UINT64 PackPos
						1, // UINT64 NumPackStreams
						SIG7z.SIZE,
						]).concat(z7uint64(data.length)).concat([
					SIG7z.END,
					SIG7z.UNPACKINFO,
						SIG7z.FOLDER,
						1, // UINT64 NumFolders
						0, // BYTE External
						// following is the folder entry
						1, // UINT64 NumCoders
						3, // DecompressionMethod.IDSize
						4, 1, 8, // misc/zip/deflate
						SIG7z.CODUNPACKSIZE,
						]).concat(z7uint64(footer.length)).concat([
						/*
						SIG7z.CRC,
						1, // BYTE AllAreDefined
						]).concat(crc32buffer(footer).toJSON()).concat([
						*/
					SIG7z.END,
				SIG7z.END
			]));
			cb(null, data, ret);
		});
	} catch(x) {
		cb(x);
	}
}
