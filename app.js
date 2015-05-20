"use strict";
/*jslint node: true */

var express = require('express');
var path = require('path');
var favicon = require('serve-favicon');
var morgan = require('morgan');
var pseudo = require('./pseudo-request');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var multer  = require('multer');
var _ = require('underscore');
var routes = require('./routes/index');

process.title = 'ki1r0y'; // so we can kill the server with shell (pkill kilroy)
var app = express();
var isDev = app.get('env') === 'development';
app.locals.title = process.title[0].toUpperCase() + process.title.slice(1);
// W3C recommends not aging more than a year. Express/connect expresses time in milliseconds (as for node generally).
app.locals.oneYearMs = 60 * 60 * 24 * 365 * 1000;

// For efficient uploads, we fs.rename files from uploadDir to db, but that won't work if they are on different file systems.
app.set('dbdir', path.resolve(__dirname, '../db'));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');
// Alas, morgan isn't smart enough to turn off colors when not a tty.
var logger = morgan((isDev && process.stdin.isTTY) ? 'dev' : 'combined');
pseudo.configure(logger);
function mutable(collection) { return express.static(path.join(app.get('dbdir'), 'mutable', collection)); }
function immutable(collection) { return express.static(path.join(app.get('dbdir'), 'immutable', collection), {maxAge: app.locals.oneYearMs}); }

app.use(favicon(path.join(__dirname, 'public/images/favicon.ico')));
app.use(logger);
app.use(bodyParser.json());    //app.use(bodyParser.urlencoded({ extended: false }));
app.use(multer({dest: path.resolve(__dirname, '../uploads/'), putSingleFilesInArray: true}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', routes);

// Puns: We could make all get/post/delete be computed with its own function, specific to the particular route.  But if
// we make the routes look like they correspond directly to static files on a file system, it gives us the opportunity
// to actually implement them that way if we want to. In fact, 'get' is implemented by just grabbing the named file, and
// 'delete' is implemented by a generic middleware that just deletes the named file. (post is separate) In both 'get'
// and 'delete, respective the middlewares convert, e.g., /thing/123.json to ../db/immutable/thing/123.json. We could
// have gone even further and had them also add the .json file extension, so that browsers would not have to include
// those four extra characters in the url. Instead, we chose to make the extension an explicit part of the url (rather
// than implied), as this serves as documentation, and helps various options for middleware figure out what they need to
// do without having to right special machinery.  For example, if the file extension was implicit, we could still use
// express.static, and give it a special function to set the Content-Type header to application/json. By making the
// extension explicit in the url, we don't need to. This gives us more flexibility to, e.g., replace express.static with
// something like Amazon S3 (slow!), which might not have the hook we need to do the transformation. For media, it makes
// it easier to inspect the uploaded files. In other words, we're trying to be "normal" in our conventions.

// Uniform length names makes it easy to visually grok logs.
// Singular names are internal resource transfers.
app.use('/media', immutable('media'));
app.use('/thing', immutable('thing'));
app.use('/thumb', immutable('thumb'));
app.use('/place', mutable('place'));
//      '/fbusr (person) download isn't needed, and it would create issues for access control and when there are large numbers of user-created scenes.
app.get('/xport/:objectIdtag', routes.exportMedia); // A dynamically generated .zip of the media associated with a (composite) thing.

app.post('/fbusr/:id.json', routes.updateUser);
app.post('/place/:id.json', routes.uploadPlace);
app.post('/thing/:id.json', routes.uploadObject);
app.post('/thumb/:id.png', routes.uploadThumbnail);
app.post('/pRefs/:id.json', routes.uploadRefs);
app.post('/media/:id', routes.uploadMedia);

// Handy for testing:
app.get('/scenes/:objectIdtag.json', routes.refs);
app.get('/citations/:text', routes.citations);
app.get('/search/:text', routes.search);
app.delete('/:collection/:id.:ext', routes.delete);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
	_.noop(req, res);
	var err = new Error('Not Found');
	err.status = 404;
	next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (isDev) {
  app.use(function (err, req, res, next) {
	  _.noop(req, next);
	  if (err.status !== 404) { console.error(err.stack); }
      res.status(err.status || 500);
      res.render('error', {
		  message: err.message,
		  error: err
      });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function (err, req, res, next) {
	_.noop(req, next);
	res.status(err.status || 500);
	res.render('error', {
		message: err.message,
		error: {}
	});
});

module.exports = app;
require('./realtime-garbage-collector').pingPong(app.get('dbdir'), 2000);
