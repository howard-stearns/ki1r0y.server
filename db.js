"use strict";
/*jslint node: true, nomen: true, vars: true, plusplus: true, forin: true */

// API for persisted objects and info about them.
// Currently just the start of such.
// TODO: redefine all the fs operations in index|people|garbageCollection to use operations defined here.

var path = require('path');
var util = require('util');
var async = require('async');
var _ = require('underscore');
var fs = require('fs-extra'); // fixme remove? Also check other files and see if we can remove from package.json
var store = require('ki1r0y.fs-store');
var search = require('ki1r0y.simple-search');
var pseudo = require('./pseudo-request');

//function isPlace(idtag) { return idtag.length !== 40; } // predicate true if idtag is for a place (a mutable, versioned thing)
function isPlace(idtag) { return (idtag.length === 37) || (idtag.length === 28) || (idtag.length === 41); } // FIXME: transition hack: 37=MS-GUID, 27=sha1/base64-=, 40=sha1/hex

var root; // set by initialize();
// These all answer falsey if no arg.
function dbFile(key, base, ext) { return key ? path.resolve(root, base, key) + (ext || '') : ''; } // internal helper
function newspaceDir(oldspace) { return oldspace + '2'; }
function newspaceFile(filePath) {
    return dbFile(path.basename(filePath), newspaceDir(path.dirname(filePath)));
}
function compatableExtension(idtag) { // FIXME: Should just be .json, but handling old style idtags for transition
    return ((40 <= idtag.length) && (idtag.length <= 41)) ? '.json' : '';
}
exports.newspaceFile = newspaceFile; // fixme remove after testing
function idFile(idtag) {  // answer pathname for place or thing
    return dbFile(idtag, isPlace(idtag) ? 'mutable/place' : 'immutable/thing', compatableExtension(idtag));
}
function userFile(idtag) { // answer pathname for our user data record
    return dbFile(idtag, 'mutable/people', compatableExtension(idtag));
}
function thumbFile(idvtag) { // thumbnail for idvtag
    var base = dbFile(idvtag, 'immutable/thumb');
    return base ? base + '.png' : '';
}
function mediaFile(filename) { // filename must have extension
    return dbFile(filename, 'immutable/media');
}
function refsFile(idtag) { // answer pathname for the list of scenes that reference idtag
    return dbFile(idtag, 'mutable/refs');
}
// FIXME: needs subdirectories.
function citationsFile(word) { // answer pathname for the list of idtags that cite the given word
    return dbFile(word, 'mutable/citation');
}
exports.idFile = idFile;
exports.userFile = userFile;

// Add idtag to the data in recordId IFF it is not already present, and creating record if needed.
// Then call optionalCallback with any error.
function pushIfNew(recordId, idtag, callback) {
    if (!recordId) { return callback(null); }
    store.update(recordId, [], function (data, writerFunction) {
        if (data.indexOf(idtag) >= 0) {
            return writerFunction(); // no need to update
        }
        data.push(idtag);
        writerFunction(null, data);
    }, callback);
}

/********* OBJECTS **************/
// Answer an object with the fully resolved information about idtag (which must be for a place or thing).
// The object is mostly suitable for a search resultRow(object) in the browser. isScene is used to
// determine whether sceneIdtag/sceneNametag vs objectIdtag/objectNametag should be set (and the other left blank).
function resolve(idtag, isScene, callback, originalIdtag, created) {
    var dbPathname = idFile(idtag);
    store.getWithModificationTime(dbPathname, function (err, obj, mtime) {
        if (err) { return callback(err); }
        if (obj.idvtag) {  // The request is for a generic place.
            resolve(obj.idvtag, isScene, callback, idtag, mtime.getTime().toString());
        } else {
            obj.timestamp = mtime.getTime().toString();
            obj.created = created || obj.timestamp;
            obj.idvtag = idtag;
            // Compatability with old names:
            obj.userIdtag = obj.userIdtag || obj.author;
            obj.nametags = obj.nametags || [obj.nametag];

            idtag = originalIdtag || idtag;
            if (isScene) {
                obj.sceneIdtag = idtag;
                obj.sceneNametag = obj.nametags[0];
            } else {
                obj.objectIdtag = idtag;
                obj.objectNametag = obj.nametags[0];
            }

            callback(null, obj);
        }
    });
}
var markMaterials; //forward reference
// Store data for idvtag, with callback(err). Used for both places and things. 
// When a place is changed, it uploads both the place and the version thing data. Both have nametag/description, but we
// only want to add citations for places and for non-place things. (Because the citation should point back to an idtag,
// not an idvtag.) Hence the flag, which is only truthy for version things. Note that version things still need materials
// added (because places don't include that data). Thus places + non-place things => do citations; any thing => do materials
function update(idvtag, data, flag, callback) {
    if (!data) { return callback(new Error("Update of " + idvtag + " with no data, flag=" + flag)); }
    var path = idFile(idvtag);
    store.set(path, data, function (eWrite) { // locked against gc sweep of path
        if (eWrite) { return callback(eWrite); }
        store.ensure(newspaceFile(path), function (eTouch) {
            if (eTouch) { return callback(eTouch); }
            // Materials were already uploaded, possibly in an earlier generation of the gc, so must be re-marked.
            markMaterials(data.materials || [], function (eMat) {
                if (eMat || flag) { return callback(eMat); }
                var text = data.nametag;
                if (data.desc) { text += ' ' + data.desc; }
                search.addCitations(idvtag, text, callback);
            });
        });
    });
}

// Instead of generically deleting the specified file, we could define deletion as a higher level operation
// that knows what referenced pieces to delete. The idea would be that this is "safer" than generic file deletion
// because the high level operations could be written to check for consistency. Alas, my own experience with this 
// is that even passing unit tests of the high level operations fail to keep up with changes to the model, and so
// one always ends up with inconsistencies. Additionally, you always end up writing a script to delete a whole 
// bunch of stuff at once, and those scripts have to be tested, and those tests have to have knowledge of the latest
// interdependencies. So I think that, in a classic application of the End-to-End Principle, it's best to just
// define the simplest interface possible, and let the higher-level scripts enforce the safety that only they can.
function remove(idtag, collection, ext, cb) { // delete the specified object from the collection
    // ext is usually implicit in the collection type, and will thus be ignored. But that's not true for media.
    var pathname;
    switch (collection) {
    case 'media':
        pathname = mediaFile(idtag + '.' + ext);
        break;
    case 'fbusr':
        pathname = userFile(idtag);
        break;
    case 'place':
    case 'thing':
        pathname = idFile(idtag);
        break;
    case 'refs':
        pathname = refsFile(idtag);
        break;
    case 'thumb':
        pathname = thumbFile(idtag);
        break;
    default:
        return cb(new Error("Unknown collection " + collection));
    }
    store.destroy(pathname, cb); // Not a pretty error, but this is supposed to be require access control, so the error should be meaningful for us.
}
exports.remove = remove;

// Like resolve, but for an array of idtags, which must all be scenes.
function resolveScenes(sceneIdtags, callback) {
    var eachScene = function (idtag, cb) {
        store.get(idFile(idtag), function (err, obj) {
            // No sense killing everything on err. Just give blank data. E.g., delete a scene that appears in obj's refs.
            if (err) { obj = {versions: {}}; }
            var timestamps = Object.keys(obj.versions);
            obj.timestamp = timestamps.length && timestamps[timestamps.length - 1];
            // compatability with old names:
            obj.userIdtag = obj.userIdtag || obj.author;
            obj.nametags = obj.nametags || [obj.nametag];

            obj.sceneIdtag = idtag;
            obj.sceneNametag = obj.nametags[0];

            delete obj.versions; // a bit verbose, otherwise
            delete obj.author;
            delete obj.nametag;

            cb(null, obj); // no err. see above.
        });
    };
    async.mapLimit(sceneIdtags, 50, eachScene, callback);
}
// Like resolve, but for user data, which isn't the same set of properties.
// Trevor is "100004567501627". Howard is "100000015148499".
function resolveUser(idtag, callback) {
    store.get(userFile(idtag), function (err, obj) {
        if (err) { return callback(err); }
        obj.nametags = [obj.nametag, obj.firstname, obj.lastname];
        obj.userIdtag = idtag;
        callback(null, obj);
    });
}
function updateUser(userIdtag, userData, callback) {
    var path = userFile(userIdtag);
    store.update(path, undefined, function (data, writerFunction) {
        if (!data) {
            pseudo.info('/pseudoOp/newUser?name=' + encodeURIComponent(userData.username || 'null') + '&id=' + userIdtag);
            data = {};
        }
        data.firstname = userData.firstname || data.firstname;
        data.lastname = userData.lastname || data.lastname;
        data.username = userData.username || data.username;
        data.description = userData.description || data.description;
        data.gender = userData.gender || data.gender;
        data.lastVisited = userData.scene || data.lastVisited;
        // Order scenes by last visited (if it is one of them), so that you/friends visit what you are/were working on.
        data.scenes = data.scenes || [];
        if (userData.obsolete) {
            var index = data.scenes.indexOf(userData.obsolete);
            if (index >= 0) { data.scenes.splice(index, 1); }
        }
        var lastIndex = data.scenes.indexOf(userData.scene);
        if (lastIndex >= 0) { // If already known to be one of mine, put it up front.
            var newLead = data.scenes.splice(lastIndex, 1);
            data.scenes = newLead.concat(data.scenes);
        } else if (userData.isMine) { // Otherwise, if marked so, make it one of mine.
            // Note that this will list it with mine and keep it from being GC'd, but
            // will not actually make me author.
            data.scenes.unshift(userData.scene);
        }
        writerFunction(null, data, data);
    }, callback);
}
// Calls iterator(userObject, cb, userIdtag) on each user's data. iterator must call cb(err) to continue.
// finalCallbac(err) is called on error or when all cb have been used.
function iterateUsers(iterator, finalCallback) {
    var dir = path.resolve(root, 'mutable/people');
    store.iterateDocuments(dir, function (user, userIdtag, icb) {
        iterator(user, icb, userIdtag);
    }, finalCallback);
}

////// REFS ////////
function addReference(idtag, sceneIdtag, callback) { // add sceneIdtag to the list of scenes that use idtag
    pushIfNew(refsFile(idtag), sceneIdtag, callback);
}
// answer the list of scenes that use this object (which must be a place or thing idtag, not a place's idvtag)
function referringScenes(objectIdtag, callback) {
    // Would it be worth it to rewrite the refs file if there are scenes that have no data (i.e., have been deleted)?
    store.get(refsFile(objectIdtag), function (err, refsSerialization) {
        // Not sure this is the right thing in general, but scenes should refer to themselves.
        if (store.doesNotExist(err)) { return callback(null, [objectIdtag]); }
        callback(err, refsSerialization);
    });
}
exports.resolve = resolve;
exports.resolveUser = resolveUser;
exports.resolveScenes = resolveScenes;
exports.addReference = addReference;
exports.referringScenes = referringScenes;
exports.update = update;
exports.updateUser = updateUser;
exports.iterateUsers = iterateUsers;

/********* SEARCH **************/


// Answer an array of data objects suitable for setRelated in the browser.
function textSearch(text, callback) {
    // First get the sorted list of idtags that each mention words within the search text, best matches first.
    search.findIdtags(text, function (err, idtags) {
        if (err) { return callback(err); }
        // For each citing object idtag, give two pieces of info to the cb:
        var eachCitation = function (idtag, cb) {
            async.parallel([
                function (objcb) {
                    // The object data for the citing object idtag. This is where we get object info for the result.
                    // Instead of using objcb directly, this func suppresses error (and data) for missing files.
                    resolve(idtag, false, function (e, r) { if (store.doesNotExist(e)) { objcb(null, null); } else { objcb(e, r); } });
                }, function (refscb) {
                    // A list of scene data objects that the citing object idtag can be found in. This will form the basis of each item in our eventual answer.
                    referringScenes(idtag, function (err, relatedScenes) {
                        if (err) { return refscb(err); }
                        resolveScenes(relatedScenes, refscb);
                    });
                }], cb);
        };
        var whenDone = function (err, mappedData) {
            if (err) { return callback(err); }
            // zip up the results:
            var results = [];
            mappedData.forEach(function (objectScenesPair) {
                var obj = objectScenesPair[0];
                if (!obj) { return; } // e.g., suppose version is gc'd but not the scene. See above comment re objcb.
                var scenesData = objectScenesPair[1];
                results = results.concat(scenesData.map(function (scene) {
                    if (!scene.timestamp) { return undefined; }
                    scene.objectIdvtag = obj.objectIdvtag; // get the picture of the object, not the scene.
                    scene.objectIdtag = obj.objectIdtag;
                    scene.objectNametag = obj.objectNametag;
                    var answer = {
                        idvtag: obj.idvtag,
                        timestamp: obj.timestamp,
                        userIdtag: obj.userIdtag,
                        sceneIdtag: scene.sceneIdtag,
                        sceneNametag: scene.sceneNametag
                    };
                    if (obj.objectIdtag !== scene.sceneIdtag) {
                        answer.objectIdtag = obj.objectIdtag;
                        answer.objectNametag = obj.objectNametag;
                    }
                    return answer;
                }).filter(function (x) { return x; }));
            });
            callback(null, results);
        };
        async.mapLimit(idtags, 50, eachCitation, whenDone);
    });
}
exports.search = textSearch;

/********* MEDIA **************/
function thumbFromPath(id, copies, path, callback) { // Copy contents of path into a thumbnail with the given ids, and callback.
    // FIXME: The multer package now supports a file object buffer property, as well as the path property we use. Passing this would avoid the readFile.
    var thumb = thumbFile(id);
    store.rename(path, thumb, function (err) { // No need for newspace copy. See rmStore.
        if (err || !copies.length) { return callback(err); }
        store.getBuffer(thumb, function (err, data) { // read once, write many
            if (err) { return callback(err); }
            async.eachSeries(copies, function (id, cb) {
                store.setBuffer(thumbFile(id), data, cb);
            }, callback);
        });
    });
}
// Media are immutable and so write order doesn't matter, but they are big.
function mediaFromPath(id, sourcePath, callback) { // Copy contents of path into newspace. id must have extension.
    // Mark now, in case the object that uses it isn't uploaded until a later generation of the gc.
    var oldpath = mediaFile(id);
    store.ensure(newspaceFile(oldpath), function () {
        store.rename(sourcePath, oldpath, callback);
    });
}
function mtlName(spec) { return spec.map || spec; } // spec can be simple material name or an object with a map propert.
function markMaterials(materialsList, callback) { // Mark the list and callback(err, nNotAlreadyMarked)
    var count = 0; // A lot of trouble just to get an approximate count (due to interleaved writes), but it's worth it for debugging the gc
    async.eachSeries(materialsList, function (spec, cb) { // serially to avoid blowing the process stack during gc
        var newpath = newspaceFile(mediaFile(mtlName(spec)));
        store.exists(newpath, function (exists) {
            if (exists) { return cb(null); }
            count++;
            store.ensure(newpath, cb);
        });
    }, function (err) { callback(err, count); });
}

// Recursively collects all the media references of idtag.
// In cb(err, result), result has properties:
//   nametag: the nametag of the top level object identified by idtag.
//   resources: a dictionary mapping media filename to the nametag of the (possibly lower level) object it came from.
//   directory: the path to the directory where the actual filenames can be found.
function resolveMedia(idtag, cb, media) {
    resolve(idtag, false, function (err, data) {
        if (err) { return cb(err, media); }
        if (!media) { media = {directory: path.resolve(root, 'immutable/media'), resources: {}}; }
        if (!media.nametag) { media.nametag = data.nametag; }
        // FIXME: if mesh, concatenate material defs into a .mtl file.
        (data.materials || []).forEach(function (spec) { media.resources[mtlName(spec)] = data.nametag; });
        // FIXME: if mesh, reference .mtl file and material names.
        // FIXME include audio/video data.
        async.each(data.children || [], function (child, childCallback) {
            resolveMedia(child.idtag, function (e, m) { _.noop(m); childCallback(e); }, media);
        }, function (e) { cb(e, media); });
    });
}
exports.thumbFromPath = thumbFromPath;
exports.mediaFromPath = mediaFromPath;
exports.markMaterials = markMaterials;
exports.resolveMedia = resolveMedia;


/********* STORES **************/
// Maintaining directories or data sets for garbageCollection.

var markedDirs = ['mutable/place', 'immutable/thing', 'immutable/media']; // order matches gc querystring printing for easier reading
function initialize(base, cb) { // Ensure that each newspace is an empty data store
    root = base; // used by collection name functions
    function cleanPair(oldspace, icb) {
        var oldpath = path.resolve(base, oldspace);
        var newpath = newspaceDir(oldpath);
        pseudo.info('/pseudoOp/db.initialize?oldspace=' + oldspace);
        store.ensureCollection(oldpath, function (e) {
            if (e) { return icb(e); }
            // wipe newpath clean
            store.destroyCollection(newpath, function (e) {
                if (e) { return icb(e); }
                store.ensureCollection(newpath, icb);
            });
        });
    }
    async.each([
        path.resolve(base, 'mutable/people'),
        path.resolve(base, 'mutable/citation'),
        path.resolve(base, 'mutable/refs'),
        path.resolve(base, 'immutable/thumb')
    ], store.ensureCollection, function (e) {
        if (e) { return cb(e); }
        async.each(markedDirs, cleanPair, cb);
    });
}

function sweep(stats, callback) { // swap each oldspace path in paths, with the the corresponding newspace
    // During gc and while waiting for the asynchronous actions of sweep, new data is still being
    // written to both oldspace and newspace. That's ok, because we only sweep/delete files that
    // are not in newspace by any means (regardless of who/when it was marked in newspace).
    var swap1 = function (oldpath, newpath, doCheck, cb) {
        var label = path.basename(oldpath), labelExist = label + 'Kept', labelDeleted = label + 'Deleted';   // just for debugging
        oldpath = path.resolve(root, oldpath);
        newpath = path.resolve(root, newpath);
        stats[labelExist] = stats[labelDeleted] = 0; // ditto
        store.iterateIdentifiers(oldpath, function (oldf, f, icb) {
            var newf = dbFile(f, newpath);
            store.destroy(newf, function (e1) {
                if (!e1) {
                    stats[labelExist]++;
                    icb(e1);
                } else {
                    if (store.doesNotExist(e1)) { e1 = null; }
                    stats[labelDeleted]++;
                    store.destroy(oldf, function (e2) {
                        if (doCheck) {
                            store.destroy(thumbFile(f), function (e3) {
                                store.destroy(refsFile(f), function (e4) {
                                    icb(e1 || e2 || (!store.doesNotExist(e3) && e3) || (!store.doesNotExist(e4) && e4));
                                });
                            });
                        } else {
                            icb(e1 || e2);
                        }
                    });
                }
            });
        }, cb);
    };
    async.eachSeries(markedDirs, function (dirpath, pathCb) {
        swap1(dirpath, newspaceDir(dirpath), dirpath === 'immutable/thing', pathCb);
    }, callback);
}
// mark (or copy) thing and callback(err, dataObject).
// dataObject will be null IFF idtag was already marked in this generation and forceData was falsey.
function mark(idtag, callback, forceData) {
    var oldPath = idFile(idtag);
    var newPath = newspaceFile(oldPath);
    // Only do the work if it is not already marked. 
    // (We could skip the test for scenes (which are only ever referenced once from owner),
    //  but I assume it's not worth the complexity.)
    store.exists(newPath, function (exists) {
        if (exists && !forceData) { return callback(null, null); }
        // It's ok if someone else snuck in and touched newPath in the time between starting exists and it's callback.
        // We'll repeat some work (and the gc results accounting will be slightly inflated), but the results will still be correct.
        store.get(oldPath, function (readError, obj) {
            if (readError) { return callback(readError); }
            if (!exists) {
                store.ensure(newPath, function (e) {
                    callback(e, obj);
                });
            } else {
                // We could skip the parsing for non-scene places, because the value isn't used (except for it's truthiness).
                callback(null, obj);
            }
        });
    });
}
exports.initialize = initialize;
exports.mark = mark;
exports.sweep = sweep;

search.configure({
    storage: function citationUpdate(word, updater, cb) {
        var file = citationsFile(word);
        if (!file) { return cb(null, []); }
        store.update(file, [], updater, cb);
    },
    // It is possible that an old immutable used this word and has since been garbage collected,
    // and yet the original author recreates the same object during async.filter and store.exists.
    // The newly (re-)written immutable will not appear in the citation results, which is ok.
    // More importantly, though, the new citation will cause the citationsFile to be rewritten,
    // which can't occur until this store.update completes.
    /* This version only checks the idFile, not what it points to:
       var paths = citations.map(idFile); // as pathnames
       async.filter(paths, store.exists, function (filteredPaths) {*/
    // This version checks deeper
    idtagExists: function (id, cb) {
        var path = idFile(id);
        if (!isPlace(id)) {
            store.exists(path, cb);
        } else {
            store.get(path, function (e, r) { // check place and current version
                if (e) { return cb(false); }
                store.exists(idFile(r.idvtag), cb);
            });
        }
    }
});
exports.searchCitations = search.findIdtags;
