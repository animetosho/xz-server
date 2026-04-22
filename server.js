"use strict";

var z7 = require('./7z.js');


var log4js = require('log4js');
if('appenders' in log4js) {
	// assume old version (0.6.18-1)
	log4js.configure({
	  appenders: [
		{ type: 'console' },
		{ type: 'file', filename: 'xzserv.log' }
	  ]
	});
	log.setLevel('INFO');
} else {
	// assume new version (4.0.2-2)
	log4js.configure({
	  appenders: {
		console: { type: 'console' },
		file: { type: 'file', filename: 'xzserv.log' }
	  },
	  categories: { default: { appenders: ['console', 'file'], level: 'INFO' } }
	});
}

global.log = log4js.getLogger();


var db;
var dbConnect = function() {
	db = require('mysql').createPool({
		socketPath: '/var/run/mysqld/mysqld.sock',
		user: 'xzserv',
		password: 'xxxx',
		database: 'storage',
		connectionLimit: 1,
		waitForConnections: true,
	});
	db.on('connection', function(conn) {
		conn.query('SET SESSION wait_timeout=1209600, interactive_timeout=1209600'); // two weeks
	});
};
dbConnect();

var dbQuery = function(q, cb) {
	// TODO: handle errors/disconnects better
	log.trace('DB query: ' + q);
	db.query(q, cb);
};


const zstd = require('zstd-napi');
const decomp = new zstd.Decompressor();
decomp.loadDictionary(require('fs').readFileSync('attach.dict'));
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const msgpack = require('msgpack');

var deferExit = function(code) {
	setTimeout(function() {
		process.exit(code);
	}, 1000).unref();
};

process.on('SIGTERM', function() {
	log.info('SIGTERM received, exiting');
	db.end();
	deferExit(0);
});
process.on('SIGINT', function() {
	log.info('SIGINT received, exiting');
	db.end();
	deferExit(0);
});
process.on('exit', function() {
	log.info('Process terminated');
});
process.on('uncaughtException', function(err) {
	log.fatal('Unhandled exception: ', err);
	deferExit(1);
});

var respondErr = function(code, text, req, resp) {
	resp.setHeader('Content-Type', 'text/plain; charset=iso-8859-1');
	resp.setHeader('Cache-Control', 'no-cache, must-revalidate');
	resp.setHeader('Pragma', 'no-cache');
	resp.setHeader('Expires', 'Sat, 1 Jan 2000 01:00:00 GMT');
	resp.writeHead(code);
	resp.end(text);
	req.socket.destroy();
};

var server = require('http').createServer(function(req, resp) {
	var m;
	
	log.debug('HTTP request: ' + req.url);
	
	// get request info
	if(m = req.url.match(/^\/((?:tor)?attachp(?:ac)?k)\/(\d+)(\/[\/]*\.7z)?/)) {
		sendAttachpack(m, req, resp);
	} else {
		respondErr(403, 'Forbidden', req, resp);
	}
});

try {
	require('fs').unlinkSync('/tmp/xzserv.sock');
} catch(x){}
server.listen('/tmp/xzserv.sock');
log.info('Server started listening');

var attachFilename = function(id) {
	var b = Buffer.from('00000000', 'hex');
	b.writeUInt32BE(id, 0);
	b = b.toString('hex');
	return '/storage/storage/attachments/' + b.substr(0, 5) + '/' + b.substr(5) + '.xz';
};
var sendAttachpack = function(m, req, resp) {
	var id = m[2]|0;
	var torpack = (m[1].startsWith('tor'));
	// query for attachment info
	dbQuery(
		torpack ?
		'SELECT f.id,attachments,f.filename AS ffn FROM toto_repl.toto_attachments a' +
		' JOIN toto_repl.toto_files f ON a.fid=f.id' +
		' WHERE toto_id='+id
		:
		'SELECT fid AS id,attachments FROM toto_repl.toto_attachments' +
		' WHERE fid='+id,
	function(err, rows) {
		if(err) {
			respondErr(500, 'Query failure', req, resp);
			log.error('Query failed: ', err);
			return;
		}
		
		if(rows.length < 1) {
			respondErr(404, 'Id not found', req, resp);
			return;
		}
		
		// retrieve attachment files
		let attachments = {};
		rows.map(function(e) {
			// unpack attachment data
			if(e.attachments[0] == 0xff)
				e.attachments = e.attachments.slice(1);
			else
				e.attachments = decomp.decompress(Buffer.concat([ZSTD_MAGIC, e.attachments]));
			e.attachments = msgpack.unpack(e.attachments);
			
			
			[0,1].forEach(type => {
				if(!e.attachments[type]) return;
				e.attachments[type].forEach(attach => {
					if(!attach) return; // missing file, probably too large so not stored
					let fn = '';
					if(type == 0) { // attachment
						if(attach.name)
							fn = 'attachments/' + attach.name;
						else
							fn = 'attachments/unnamed_' + attach._afid;
					} else { // subtitle
						fn = 'track';
						if(attach.tracknum)
							fn += attach.tracknum;
						if(attach.lang)
							fn += '.' + attach.lang;
						if(attach.codec == 'VOB')
							fn += attach.vobidx ? '.idx' : '.sub';
						else if(attach.codec == 'PGS')
							fn += '.sup';
						else if(attach.codec)
							fn += '.' + attach.codec.toLowerCase();
					}
					if(torpack) fn = e.ffn + '/' + fn;
					
					if(attach._afid in attachments)
						attachments[attach._afid].push(fn);
					else
						attachments[attach._afid] = [fn];
				});
			});
			[2,3].forEach(type => {
				if(!e.attachments[type]) return;
				const afid = e.attachments[type];
				let fn = (type == 2 ? 'chapters.xml' : 'tags.xml');
				if(torpack) fn = e.ffn + '/' + fn;
				if(afid in attachments)
					attachments[afid].push(fn);
				else
					attachments[afid] = [fn];
			});
		});
		(function(done) {
			if(Object.keys(attachments).length)
				dbQuery(
					'SELECT af.id,packedsize,cacheinfo FROM toto_repl.toto_attachment_files af' +
					' LEFT JOIN toto_attachment_files_storecache c ON af.id=c.id' +
					' WHERE af.id IN('+Object.keys(attachments).join(',')+')',
					done
				);
			else
				done();
		})(function(err, rows) {
			if(err) {
				respondErr(500, 'Query failure', req, resp);
				log.error('Query failed: ', err);
				return;
			}
			
			const attachment_files = {};
			if(rows) rows.forEach(r => {
				attachment_files[r.id] = r;
			});
			
			// check if we have cached info
			var cacheInfo={}, fileInfo=[];
			var doGenCache = false;
			for(let afid in attachments) {
				let ci;
				const af = attachment_files[afid] || {};
				if(af.cacheinfo) {
					try {
						ci = JSON.parse(af.cacheinfo);
					} catch(x) {
						ci = null;
						log.warn('JSON parse failed for ' + afid);
					}
					if(ci) {
						ci.filename = attachFilename(afid);
						attachments[afid].forEach(fn => {
							fileInfo.push(Object.assign({name: fn}, ci));
						});
						continue;
					}
				}
				
				attachments[afid].forEach(fn => {
					cacheInfo[afid] = [attachFilename(afid), af.packedsize];
					doGenCache = true;
				});
			}
			
			// generate info for stuff that isn't cached
			(function(cb) {
				if(doGenCache) {
					z7.cacheFileInfo(cacheInfo, function(err, results) {
						if(err) {
							respondErr(500, 'Sorry, the 7z package could not be generated - this may be because attachments have not yet been fully synced. Please try again in a few minutes. If the issue persists, please post a comment and we will look into it.', req, resp);
							log.error('Cache gen failed for fid=' + id + ': ', err);
							return;
						}
						
						// insert into DB
						var query = '';
						for(var i in results) {
							var info = results[i];
							query += (query ? '),(':'') + db.escape(i) + ',' + db.escape(JSON.stringify(info));
							
							attachments[i].forEach(function(fit) {
								fileInfo.push(Object.assign({
									name: fit,
									filename: attachFilename(i)
								}, info));
							});
						}
						// INSERT IGNORE to get around race conditions
						dbQuery('INSERT IGNORE INTO toto_attachment_files_storecache(id, cacheinfo) VALUES(' + query + ')', function(err) {
							// ignore error - we can always re-cache
							if(err) log.error('Cache update failed: ', err);
							// in fact, let's ignore the query altogether :P
						});
						
						attachments = null;
						cacheInfo = null;
						cb();
					});
				} else cb();
			})(function() {
				
				// have all info - send file
				resp.setHeader('Content-Disposition', 'attachment');
				resp.setHeader('Content-Type', 'application/x-7z');
				// cache headers
				resp.setHeader('Cache-Control', 'public');
				var expiry = new Date();
				expiry.setDate(expiry.getDate() + 7);
				resp.setHeader('Expires', expiry.toUTCString());
				
				// content-length header needs to be sent later
				
				resp.useChunkedEncodingByDefault = false; // TODO: remove this?
				
				z7.combineTo7zCached(fileInfo, req, resp);
			});
		});
	});
};
