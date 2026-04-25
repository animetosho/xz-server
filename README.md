# xz Package Server

This is a HTTP server which serves multiple XZ files as a single 7z archive. It is designed specifically for Anime Tosho’s use, enabling users to download all attachments of a file as a package, and pulls relevant info (like which XZ files to concatenate) from a MySQL database.

## Purpose

Anime Tosho stores attachments individually as compressed XZ files. As many attachments, such as fonts, are frequently shared across multiple releases, storing attachments separately (as opposed to as 7z packages) enables deduplication. However separate files are less convenient for users to download, so this server provides a way to package up relevant attachments into a single download.

When a user requests an attachment package for download, the server:

1. queries the database for the specified file/torrent to determine which attachments need to be packaged up
2. for each attachment XZ file, locate the LZMA2 stream
3. spit out a 7-Zip header followed by the LZMA2 streams located above
4. generate the main 7-Zip metadata and append it onto the above output

As 7z also supports LZMA2 compression, this allows packaging to occur without any recompression, thus uses minimal CPU resources.

## Limitations

A downside to this implementation is that there’s no solid compression applied. This has the greatest effect when a single file appears as multiple files in the package, as it must also be duplicated in the 7z data (in other words, if a font needs to be present twice in the package, there will be two *full* copies in the 7z file).
There may be a way to solve this by marking a partially solid archive and using some LZ trick to deduplicate identical files in the 7z package, but I never investigated this.

Also this application only supports XZ files created using LZMA2 compression with CRC32 check (noting that the latter may not be the default).

## Configuration

Values are hard coded in *server.js*, search for the following to change:

* `xzserv.log`: location of log file
* `db = require('mysql').createPool({`: MySQL DB connection details follow this line
* `/tmp/xzserv.sock`: location of the server’s listening socket
* `/storage/storage/attachments/`: location of XZ files
* `torpack ?`: after this line, the query that is executed to get info on a file/torrent
* `SELECT af.id,packedsize,cacheinfo`: query to pull info on XZ files
* `INSERT IGNORE INTO toto_attachment_files_storecache`: query used to cache info on where the LZMA2 stream is in each XZ file

## Setup

1. The server requires NodeJS. Perform an `npm install` to pull down dependencies.
   (if you get a build failure with msgpack, try [this](https://github.com/msgpack/msgpack-node/issues/55#issuecomment-1315719837))
2. You'll need the *toto\_repl* database with attachment data (specifically the *toto_attachments* and *toto_attachment_files* tables). This server’s DB user will need SELECT access to this database
   (alternatively, edit the queries in *server.js* to point to wherever your data is)
3. You’ll also need relevant attachment XZ files, corresponding to the database table *toto_attachment_files* data imported above
4. Import *db.sql* to create a cache table for storing XZ info. This server’s DB user will need SELECT and INSERT access
5. Modify *server.js* to set configuration (above)
6. Set up the server as a service, where *server.js* is the executed script. A sample systemd service definition is supplied in *xzserv.service*
7. Configure a web server to proxy to this server via the Unix socket (unless you’ve changed the code to listen on a port instead)
