"use strict";
/*jslint node: true, forin: true */

var fs = require('fs');
var path = require('path');
var async = require('async');
var _ = require('underscore');
var db = require('../db');
var gc = require('../realtime-garbage-collector');
var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function (req, res, next) {
	_.noop(req, next);
	res.render('index');
});

module.exports = router;

function makeUploadResponder(req, res, next) { // Answer a node callback tied to this request
	_.noop(req);
	return function (err, data) {
		if (err) { 			
			next(err);        // We could instead do: res.writeHead(500); res.end(error.message || error);
		} else if (data) {
			res.send(data);   // express will set content-type header to application/json.
		} else {
			res.send({status: "ok"}); // answer text that as parseable as JSON, to make things easier if we have other responses
		}
	};
}
// Conceptually like uploadObject, but different implementation because of their size.
// The file extension is part of the id, because we want the urls for post/get/delete to be identical, and get is most flexible if it includes extension.
router.uploadMedia = function (req, res, next) { // Handler for saving media
	var data = req.files.fileUpload[0];
	if (data.mimetype !== 'image/' + data.extension) { return next(new Error('File extension "' + data.extension + '" does not match mimetype "' + data.mimetype + '".')); }
	db.mediaFromPath(req.params.id,
					 data.path,
					 makeUploadResponder(req, res, next));
};
router.uploadThumbnail = function (req, res, next) { // Handler for saving thumbnails.
	var data = req.files.fileUpload[0];
	if (data.mimetype !== 'image/' + data.extension) { return next(new Error('File extension "' + data.extension + '" does not match mimetype "' + data.mimetype + '".')); }
	db.thumbFromPath(req.params.id,
					 req.body.additionalIds ? JSON.parse(req.body.additionalIds) : [],
					 data.path,
					 makeUploadResponder(req, res, next));
};
router.delete = function (req, res, next) {
	db.remove(req.params.id, req.params.collection, req.params.ext, makeUploadResponder(req, res, next));
};

router.uploadObject = function (req, res, next) { // flag is true for versions of a place
	db.update(req.params.id, req.body.data, req.body.flag, makeUploadResponder(req, res, next));
};
router.uploadPlace = function (req, res, next) {
	db.update(req.params.id, req.body.data, null, makeUploadResponder(req, res, next));
};

// Saving refs. We keep a db of all the scenes that a given object has ever appeared in. 
// The plugin uploads the objects that a scene uses, and here we invert that.
router.uploadRefs = function (req, res, next) {
	var sceneIdtag = req.params.id;
	async.eachLimit(req.body.data, 50,
			   function (objectIdtag, callback) { db.addReference(objectIdtag, sceneIdtag, callback); },
			   // The refs upload occurs once per save, so it's a convenient place to hook a request to garbage collect the database.
			   function (e) { gc.requestGC(); makeUploadResponder(req, res, next)(e); });
};

// We keep data (e.g., scenes and thumbnail) that do not come from fb /me API response.
// We currently keep all that info together, so we have to read the existing file in order
// to not lose anything when we re-write it. A (dubious) side-benefit is that we are somewhat
// insulated from fb and test-harness changes. (See onUserData in the public/javascripts or templates.)
router.updateUser = function (req, res, next) {
	db.updateUser(req.params.id, req.body, makeUploadResponder(req, res, next));
};

// Answer an array of data objects suitable for setRelated in the browser (as json).
// Handy for testing independent of the chat socket, or for exposing the api to others.
router.refs = function (req, res, next) {
	db.referringScenes(req.params.objectIdtag, function (err, scenes) {
		if (err) { return next(err); }
		res.send(scenes);
	});
};
router.citations = function (req, res, next) {
	db.searchCitations(req.params.text, function (err, idtags) {
		if (err) { return next(err); }
		res.send(idtags);
	});
};
router.search = function (req, res, next) {
	db.search(req.params.text, function (err, results) {
		if (err) { return next(err); }
		res.send(results);
	});
};


// Media
var child_process = require('child_process');
router.exportMedia = function (req, res, next) {
	// Download a zip containing all the media resources of the requested id.
	// We could reduce the server load by having the client produce a specific list
	// of resources -- it does have all the info. However, that would require a bunch
	// of communication between the browser and unity, so this version is cleaner programming.
	db.resolveMedia(req.params.objectIdtag, function (err, media) {
		if (err) { return next(err); }
		// serve a zip named media.nametag, whose members are each of the keys in media.resources.
		var args = ['-'], zip, key;
		for (key in media.resources) {
			// FIXME: I'd like the files to have meaningful names in the zip (media[key] + extname(key)),
			// but I don't know how.
			args.push(key);
		}
		zip = child_process.spawn('zip', args, {cwd: media.directory});
		res.contentType('zip'); // Some browsers may requires this to be before Content-Disposition.
		res.setHeader('Content-Disposition', 'attachment; filename="' + media.nametag + '.zip"');
		zip.stdout.on('data', function (d) { res.write(d); });
        //zip.stderr.on('data', function (d) { console.log(' ' + d); }); // For debugging
		zip.on('exit', function (code) {
            if (code !== 0) {
				err = 'zip process exited with code ' + code;
				// too late to use next(err);
                res.statusCode = 500;
                console.log(err);
                res.end(err);
            } else {
                res.end();
            }
        });
	});
};
