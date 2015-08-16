"use strict";
/*jslint node: true, forin: true, nomen: true */

var fs = require('fs');
var path = require('path');
var url = require('url');
var async = require('async');
var _ = require('underscore');
var db = require('../db');
var gc = require('../realtime-garbage-collector');
var express = require('express');
var router = express.Router();

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
// FIXME: abstract out the mimetype checks in each of these two functions.
router.uploadMedia = function (req, res, next) { // Handler for saving media
    var data = req.file;
    data.extension = path.extname(data.originalname).slice(1);
    if (data.mimetype !== 'image/' + data.extension) { return next(new Error('File extension "' + data.extension + '" does not match mimetype "' + data.mimetype + '".')); }
    db.mediaFromPath(req.params.id,
                     data.path,
                     makeUploadResponder(req, res, next));
};
router.uploadThumbnail = function (req, res, next) { // Handler for saving thumbnails.
    var data = req.file;
    data.extension = path.extname(data.originalname).slice(1);
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
// insulated from fb and test-harness changes. (See onMe in the public/javascripts or templates.)
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



// ki1r0y scenes
router.scene = function (req, res, next) {
    var isScene = req.params.sceneIdtag;
    db.resolve(req.params.sceneIdtag || req.params.objectIdtag, isScene, function (err, obj) {
        if (err) { return next(err); }
        var base = 'http://' + req.get('Host'); // Host header includes port, if any.
        // Note that the generic openGraph (og) metadata is supposed to be stable. Crawlers can and do cache it.
        // For mutable objects, we give current metadata (e.g., thumbnails), not the metadata that may have been 
        // in play some time back in an earlier version. 
        obj.fbAppId = (req.hostname === 'localhost') ? '' : req.app.locals.fbAppId;
        obj.canonicalUrl = base + url.parse(req.url).pathname; // No query part.
        obj.thumbnailUrl = base + '/thumb/' + obj.idvtag + '.png';
        obj.authorUrl = base + '/people/' + obj.userIdtag;
        obj.descStripped = (obj.desc || '').replace(/<[^>]+>/g, '');
        obj.requestedTimestamp = req.query.timestamp || '';
        // I don't know if this is interpreted as a cache expiration (in which case mutables
        // should answer a lesser value), or an expiration of the whole existence.
        obj.expires = new Date(Date.now() + req.app.locals.oneYearMs).getTime().toString();
        // Objects can be in multiple scenes, but can have only one author, so that makes a good stable openGraph article "section".
        obj.ogSection = obj.userIdtag;
        obj.testing = req.query.test;
        if (isScene) { // related data is the author's other scenes
            db.resolveUser(obj.userIdtag, function (err, author) {
                if (err) { return next(err); }
                obj.sceneUserUrl = base + '/people/' + obj.userIdtag;
                obj.sceneUserNametag = author.nametags[0];
                obj.sceneUrl = obj.canonicalUrl;
                db.resolveScenes(author.scenes, function (err, relatedScenesData) {
                    if (err) { return next(err); }
                    // The related data is shown in initial search results, and can provide
                    // alternatives if the user doesn't have access.
                    // Should we filter missing data from scenesData? (e.g., deleted scenes).
                    obj.related = relatedScenesData;
                    res.render('scene', obj);
                });
            });
        } else { // related data is the other scenes that use this object
            db.referringScenes(obj.objectIdtag, function (err, relatedScenes) {
                if (err) { return next(err); }
                db.resolveScenes(relatedScenes, function (err, relatedScenesData) {
                    if (err) { return next(err); }
                    var ref = req.query.fb_ref || '__',
                        // From the like buton doc: "Aggregated stream stories contain all ref parameters, concatenated with commas."
                        refs = ref.split(','),
                        refParams = refs[0].split('__'),
                        thisScene;
                    obj.sceneIdtag = refParams[1] || relatedScenes[0]; // Use first relatedScene if not otherwise specified.
                    relatedScenesData.forEach(function (s) { // add our object info to each related scene
                        s.objectNametag = obj.objectNametag;
                        s.objectIdtag = obj.objectIdtag;
                        if (s.sceneIdtag === obj.sceneIdtag) { thisScene = s; }
                    });
                    obj.related = relatedScenesData;
                    if (!thisScene) {
                        next(new Error('No related scene for url=' +  req.url + ' scene=' + obj.sceneIdtag + ' object=' + obj.objectIdtag + ' related=' + relatedScenes));
                    } else {
                        db.resolveUser(thisScene.userIdtag, function (err, sceneUser) {
                            if (err) { return next(err); }
                            obj.sceneUserUrl = base + '/people/' + thisScene.userIdtag;
                            obj.sceneUserNametag = sceneUser.nametags[0];
                            obj.sceneNametag = thisScene.sceneNametag;
                            obj.sceneUrl = base + '/places/' + obj.sceneIdtag;
                            obj.objectUrl = obj.canonicalUrl;
                            res.render('scene', obj);
                        });
                    }
                });
            });
        }
    });
};
/* 
The 'user' template is how we present our users to each other as a
"profile". When we mention a user (e.g., as the owner of something in
the scene's public metadata tab, or as the OpenGraph article:author of
our objects), it is a link to one of these user profiles.

We have to have our own OpenGraph profile pages for each user:
1. Facebook profile pages are NOT valid og profiles -- they don't have
   the right metadata. (Shame on them.)
2. We really want our user pages to show a list of all the scenes they
   own. We could make these appear on Facebook pages if we created a
   FB action each time a person makes a page. We might do that some
   day, but for now we'd rather not spam people.
3. We might want to put other Kilroy-specific info there, such as
   noteable Kilroy activity. In particular, one's own Kilroy profile
   page might have extra admin options for deleting scenes or
   followers.

In order to be crawled properly, profile pages have to provide basic
OpenGraph info in the header, regardless of whether the crawler is
"signed in" to FB, and without requiring scripts to fire. This means
we cannot provide this info using the FB api, but must instead have
our own server supply it. Fortunately, it's not much info to save.
(We update it using the FB api whenever someone logs in.)  As long as
we have to keep a picture independently of FB, we might as well make
it a picture of the user's avatar, to be displayed on this page
alongside their FB picture.
*/
router.user = function (req, res, next) {
    db.resolveUser(req.params.userIdtag, function (err, author) {
        if (err) { return next(err); }
        db.resolveScenes(author.scenes, function (err, relatedScenesData) {
            if (err) { return next(err); }
            var scene = relatedScenesData[0] || 'G2', // FIXME default is bogus
                base = 'http://' + req.get('Host'); // Host header includes port, if any.
            author.sceneIdtag = scene.sceneIdtag;
            author.idvtag = scene.idvtag;
            author.timestamp = scene.timestamp;
            author.related = relatedScenesData;
            author.canonicalUrl = base + url.parse(req.url).pathname; // No query part.
            author.thumbnailUrl = 'http://graph.facebook.com/' + author.userIdtag + '/picture';
            author.sceneUserUrl = base + '/people/' + req.params.userIdtag;
            author.sceneUserNametag = author.nametags[0];
            author.sceneNametag = scene.sceneNametag;
            author.sceneUrl = base + '/places/' + scene.sceneIdtag;
            author.fbAppId = req.app.locals.fbAppId;
            res.render('scene', author);
        });
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
