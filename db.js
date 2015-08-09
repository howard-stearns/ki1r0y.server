"use strict";
/*jslint node: true, nomen: true, vars: true, plusplus: true, forin: true */

// API for persisted objects and info about them.
// Currently just the start of such.
// TODO: redefine all the fs operations in index|people|garbageCollection to use operations defined here.

var fs = require('fs-extra');
var path = require('path');
var util = require('util');
var async = require('async');
var _ = require('underscore');
var lock = require('ki1r0y.lock').lock;
var pseudo = require('./pseudo-request');

// Alas, fs.truncate doesn't create new file on Amazon linux.
function touch(path, cb) { fs.open(path, 'w', function (e, fd) { if (e) { cb(e); } else { fs.close(fd, cb); } }); }

function isNoFile(error) { return error && (error.code === 'ENOENT'); } // predicate true if error indicates missing file
//function isPlace(idtag) { return idtag.length !== 40; } // predicate true if idtag is for a place (a mutable, versioned thing)
function isPlace(idtag) { return (idtag.length === 37) || (idtag.length === 28) || (idtag.length === 41); } // FIXME: transition hack: 37=MS-GUID, 27=sha1/base64-=, 40=sha1/hex

var root;
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
function citationsFile(word) { // answer pathname for the list of idtags that cite the given word
    return dbFile(word.toUpperCase(), 'mutable/citation');
}
exports.idFile = idFile;
exports.userFile = userFile;

function writeLockFile(path, data, cb) { // Like fs.writeFile within a lock.
    lock(path, function (unlock) {
        fs.writeFile(path, data, function (e, d) { unlock(); cb(e, d); });
    });
}
function readLockFile(path, cb) { // Like fs.readFile within a lock.
    // Would we gain anything by allowing simultaneous overlapping reads as long as there is no write?
    // (See QT's QReadWriteLock.lockForRead. Note that a waiting write lock must take precedence over newly waiting readers.)
    lock(path, function (unlock) {
        fs.readFile(path, function (e, d) { unlock(); cb(e, d); });
    });
}
function safeJson(string) {
    try { return JSON.parse(string); } catch (e) { return e; }
}


// Asynchronously calls transformer(contentString, writerFunction) on the contents of path,
// where contentString may be an empty string. The transformer should in turn call
// writerFunction(error, newContentString, optionalResult), which will leave newContentString as the sole
// content of the file unless newContentString is undefined, in which case no change is made.
// If path does not exist and noFileValue is supplied, it is used as the optionalResult without calling transformer or making the file.
// Finally, callback(error, optionalResult) is called.
// While this function does not block, callback won't happen until atomicChange is able to 
// get exclusive access to path. 
function atomicChange(path, transformer, callback, noFileValue) {
    lock(path, function (unlock) {
        fs.readFile(path, function (eRead, contentString) {
            var cb = function (error, optionalResult) {
                unlock();
                callback(error, optionalResult);
            };
            var writerFunction = function (error, newContentString, optionalResult) {
                if (error) {
                    cb(error);
                } else if (newContentString === undefined) {
                    cb(null, optionalResult);
                } else {
                    fs.writeFile(path, newContentString, function (e) { cb(e, optionalResult); });
                }
            };
            if (isNoFile(eRead)) {
                if (noFileValue !== undefined) {
                    cb(null, noFileValue);
                } else {
                    transformer('', writerFunction);
                }
            } else if (eRead) {
                cb(eRead);
            } else {
                transformer(contentString, writerFunction);
            }
        });
    });
}

// Add idtag to the data in recordId IFF it is not already present, and creating record if needed.
// Then call optionalCallback with any error.
function pushIfNew(recordId, idtag, callback) {
    if (!recordId) { return callback(null); }
    atomicChange(recordId, function (dataString, writerFunction) {
        var data;
        if (dataString) {
            data = safeJson(dataString);
            if (util.isError(data)) { return writerFunction(data); } // Shouldn't happen!
            if (data.indexOf(idtag) < 0) {
                data.push(idtag);
            } else { // no need to update
                return writerFunction();
            }
        } else {
            data = [idtag];
        }
        writerFunction(null, JSON.stringify(data));
    }, callback);
}

// Notes on file modification times:
// We originally defined creation and modification dates are defined by the server storage system, because:
// 1. express.static uses this for last-modified header (when using cache-control)
// 2. It's much less complicated than trying to handle modification time within the
//    uploaded client data, but not within the hash used to tell if something has
//    really changed.
// 3. It's unnecessary data for uploading.
// 4. We know the time is right because it's determined by server instead of client.
// But there are drawbacks:
// 1. We have a moving data garbage collector, so we have to use shell touch to preserve. 
//    That's probably doesn't scale.
// 2. This is not preserved by: git checkout -- db
// 3. The file modification time won't match the version timestamp set by the plugin during saving.
// 
// We didn't display creation time because there is no standard way
// to get it. stat.ctime is inode change time (which is useless). Darwin does
// report creation time with ls -lU, but it doesn't show up in nodejs fs stat.

/********* OBJECTS **************/
// Answer an object with the fully resolved information about idtag (which must be for a place or thing).
// The object is mostly suitable for a search resultRow(object) in the browser. isScene is used to
// determine whether sceneIdtag/sceneNametag vs objectIdtag/objectNametag should be set (and the other left blank).
function resolve(idtag, isScene, callback, originalIdtag, created) {
    var dbPathname = idFile(idtag);
    async.parallel([
        function (cb) { fs.stat(dbPathname, cb); },
        function (cb) { readLockFile(dbPathname, cb); }
    ], function (err, results) {
        if (err) { return callback(err); }
        var mtime = results[0].mtime;
        var obj = JSON.parse(results[1]);
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
var addCitations, markMaterials; //forward references
// Store data for idvtag, with callback(err). Used for both places and things. 
// When a place is changed, it uploads both the place and the version thing data. Both have nametag/description, but we
// only want to add citations for places and for non-place things. (Because the citation should point back to an idtag,
// not an idvtag.) Hence the flag, which is only truthy for version things. Note that version things still need materials
// added (because places don't include that data). Thus places + non-place things => do citations; any thing => do materials
function update(idvtag, data, flag, callback) {
    if (!data) { return callback(new Error("Update of " + idvtag + " with no data, flag=" + flag)); }
    var path = idFile(idvtag);
    writeLockFile(path, JSON.stringify(data), function (eWrite) { // locked against gc sweep of path
        if (eWrite) { return callback(eWrite); }
        touch(newspaceFile(path), function (eTouch) {
            if (eTouch) { return callback(eTouch); }
            // Materials were already uploaded, possibly in an earlier generation of the gc, so must be re-marked.
            markMaterials(data.materials || [], function (eMat) {
                if (eMat || flag) { return callback(eMat); }
                var text = data.nametag;
                if (data.desc) { text += ' ' + data.desc; }
                addCitations(text, idvtag, callback);
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
    fs.unlink(pathname, cb); // Not a pretty error, but this is supposed to be require access control, so the error should be meaningful for us.
}
exports.remove = remove;

// Like resolve, but for an array of idtags, which must all be scenes.
function resolveScenes(sceneIdtags, callback) {
    var eachScene = function (idtag, cb) {
        readLockFile(idFile(idtag), function (err, json) {
            // No sense killing everything on err. Just give blank data. E.g., delete a scene that appears in obj's refs.
            var obj = (err || !json) ? {versions: {}} : JSON.parse(json);
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
    readLockFile(userFile(idtag), function (err, json) {
        if (err) { return callback(err); }
        var obj = JSON.parse(json);
        obj.nametags = [obj.nametag, obj.firstname, obj.lastname];
        obj.userIdtag = idtag;
        callback(null, obj);
    });
}
function updateUser(userIdtag, userData, callback) {
    var path = userFile(userIdtag);
    atomicChange(path, function (existingString, writerFunction) {
        var data;
        if (existingString) {
            data = JSON.parse(existingString);
        } else {
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
        if (lastIndex >= 0) {
            var newLead = data.scenes.splice(lastIndex, 1);
            data.scenes = newLead.concat(data.scenes);
        } else if (userData.isMine) {
            data.scenes.unshift(userData.scene);
        }
        writerFunction(null, JSON.stringify(data), data);
    }, callback);
}
// Calls iterator(userObject, cb, userIdtag) on each user's data. iterator must call cb(err) to continue.
// finalCallbac(err) is called on error or when all cb have been used.
function iterateUsers(iterator, finalCallback) {
    var dir = path.resolve(root, 'mutable/people');
    fs.readdir(dir, function (err, userFiles) {
        if (err) { return finalCallback(err); }
        function eachIdtag(userFile, cb) {
            readLockFile(path.resolve(dir, userFile), function (err, json) {
                if (err) { return cb(err); }
                iterator(JSON.parse(json), cb, userFile);
            });
        }
        async.eachSeries(userFiles, eachIdtag, finalCallback);
    });
}

////// REFS ////////
function addReference(idtag, sceneIdtag, callback) { // add sceneIdtag to the list of scenes that use idtag
    pushIfNew(refsFile(idtag), sceneIdtag, callback);
}
// answer the list of scenes that use this object (which must be a place or thing idtag, not a place's idvtag)
function referringScenes(objectIdtag, callback) {
    // Would it be worth it to rewrite the refs file if there are scenes that have no data (i.e., have been deleted)?
    readLockFile(refsFile(objectIdtag), function (err, refsSerialization) {
        // Not sure this is the right thing in general, but scenes should refer to themselves.
        if (isNoFile(err)) { return callback(null, [objectIdtag]); }
        callback(err, !err && JSON.parse(refsSerialization));
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

// Ensure that idtag is listed in the citations for word.
// idtag is supposed to be a place or thing idtag (not a place's idvtag)
function addCitation(word, idtag, cb) {
    if (word) { pushIfNew(citationsFile(word), idtag, cb); } else { cb(); }
}
// Add citations for (each word in) whole text.
function addCitations(text, idtag, optionalCallback) {
    if (!text) { return optionalCallback && optionalCallback(); }
    var seen = {}; // don't addCitation of duplicate words
    var eachWord = function (word, cb) {
        if (!seen[word]) {
            seen[word] = true;
            addCitation(word, idtag, cb);
        } else {
            cb();
        }
    };
    async.eachLimit(text.split(/\W/), 50, eachWord, optionalCallback);
}
exports.addCitation = addCitation;
exports.addCitations = addCitations;

// Answer a validated list of the idtags that cite word (or an empty list if none),
// where "validated" means that the idtag is still live (not garbage collected).
// Updates citations file if needed.
function citationsOf(word, callback) {
    var file = citationsFile(word);
    if (!file) { return callback(null, []); }
    atomicChange(file, function (citationsBuffer, writerFunction) {
        // Filter the citations to include only idtags that still exist.
        var citations = JSON.parse(citationsBuffer); // just the idtags
        // It is possible that an old immutable used this word and has since been garbage collected,
        // and yet the original author recreates the same object during async.filter and fs.exists.
        // The newly (re-)written immutable will not appear in the citation results, which is ok.
        // More importantly, though, the new citation will cause the citationsFile to be rewritten,
        // which can't occur until this atomicChange completes.
        /* This version only checks the idFile, not what it points to:
           var paths = citations.map(idFile); // as pathnames
           async.filter(paths, fs.exists, function (filteredPaths) {*/
        // This version checks deeper
        var check = function (id, cb) {
            var path = idFile(id);
            if (!isPlace(id)) {
                fs.exists(path, cb);
            } else {
                readLockFile(path, function (e, r) { // check place and current version
                    if (e) { return cb(false); }
                    fs.exists(idFile(JSON.parse(r).idvtag), cb);
                });
            }
        };
        async.filter(citations, check, function (filteredPaths) {
            if (filteredPaths.length === citations.length) {
                writerFunction(null, undefined, citations);  // No change, but give the list to callback.
            } else {
                var filteredCitations = filteredPaths.map(path.basename); // Re-save and callback the filtered list.
                writerFunction(null, JSON.stringify(filteredCitations), filteredCitations);
            }
        });
    }, callback, []);
}
exports.citationsOf = citationsOf;

// Answers the sorted best matches (citing idtags) for text.
// Current implementation breaks text into words and collects all idtags that have a word as nametag,
// sorted by the number of times a word appears in object. e.g., search for 'tall block', and
// everything containing 'tall' or 'block' will be returned, but something containing both 'tall' and 'block'
// is ahead of something containing only one.
function searchCitations(text, callback) {
    var answers = {}; // map of citing idtag => score
    var eachWord = function (word, cb) { // async.each cb just takes error arg, no result.
        // Add the citations of a word to answers, incrementing answers[citation] for each insertion
        citationsOf(word, function (err, citations) {
            if (err) {
                cb(err);
            } else {
                citations.forEach(function (citation) {
                    answers[citation] = (answers[citation] || 0) + 1;
                });
                cb(null);
            }
        });
    };
    var whenDone = function (finalErr) {
        // After processing eachWord above, sort the answers keys (the citating idtags) based on score, and answer the sorted idtags.
        if (finalErr) { return callback(finalErr); }
        var ids = Object.keys(answers);
        ids = ids.sort(function (idA, idB) { return answers[idB] - answers[idA]; }); // biggest first
        callback(null, ids);
    };
    async.eachLimit(text.split(/\W/), 50, eachWord, whenDone);
}
exports.searchCitations = searchCitations;

// Answer an array of data objects suitable for setRelated in the browser.
function search(text, callback) {
    // First get the sorted list of idtags that each mention words within the search text, best matches first.
    searchCitations(text, function (err, idtags) {
        if (err) { return callback(err); }
        // For each citing object idtag, give two pieces of info to the cb:
        var eachCitation = function (idtag, cb) {
            async.parallel([
                function (objcb) {
                    // The object data for the citing object idtag. This is where we get object info for the result.
                    // Instead of using objcb directly, this func suppresses error (and data) for missing files.
                    resolve(idtag, false, function (e, r) { if (isNoFile(e)) { objcb(null, null); } else { objcb(e, r); } });
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
exports.search = search;

/********* MEDIA **************/
function thumbFromPath(id, copies, path, callback) { // Copy contents of path into a thumbnail with the given ids, and callback.
    // FIXME: The multer package now supports a file object buffer property, as well as the path property we use. Passing this would avoid the readFile.
    var thumb = thumbFile(id);
    fs.rename(path, thumb, function (err) { // No need for newspace copy. See rmStore.
        if (err || !copies.length) { return callback(err); }
        fs.readFile(thumb, function (err, data) { // read once, write many
            if (err) { return callback(err); }
            async.eachSeries(copies, function (id, cb) {
                fs.writeFile(thumbFile(id), data, cb);
            }, callback);
        });
    });
}
// Media are immutable and so write order doesn't matter, but they are big.
function mediaFromPath(id, sourcePath, callback) { // Copy contents of path into newspace. id must have extension.
    // Mark now, in case the object that uses it isn't uploaded until a later generation of the gc.
    var oldpath = mediaFile(id);
    touch(newspaceFile(oldpath), function () {
        fs.rename(sourcePath, oldpath, callback);
    });
}
function mtlName(spec) { return spec.map || spec; } // spec can be simple material name or an object with a map propert.
function markMaterials(materialsList, callback) { // Mark the list and callback(err, nNotAlreadyMarked)
    var count = 0; // A lot of trouble just to get an approximate count (due to interleaved writes), but it's worth it for debugging the gc
    async.eachSeries(materialsList, function (spec, cb) { // serially to avoid blowing the process stack during gc
        var newpath = newspaceFile(mediaFile(mtlName(spec)));
        fs.exists(newpath, function (exists) {
            if (exists) { return cb(null); }
            count++;
            touch(newpath, cb);
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

// Asynchronously apply eachFile(file, cb) to each each file in a directory, 
// followed by callback(error);
function mapDir(dir, eachFile, callback) {
    fs.readdir(dir, function (error, files) {
        if (error) { return callback(error); }
        // Apply a function to each file (of which there are many).
        // Better do series or limit so as to not blow process stack.
        //async.eachLimit(files, 50, eachFile, callback);
        async.eachSeries(files, eachFile, callback);
    });
}

var markedDirs = ['mutable/place', 'immutable/thing', 'immutable/media']; // order matches gc querystring printing for easier reading
function initialize(base) { // Ensure that each newspace is an empty data store
    var tmp = new Date().getTime();
    function cleandir(oldspace) {
        var oldpath = path.resolve(root, oldspace);
        var newpath = newspaceDir(oldpath);
        var tmpspace = oldpath + tmp;
        pseudo.info('/pseudoOp/db.initialize?oldspace=' + oldspace);
        if (!fs.existsSync(oldpath)) { fs.mkdirsSync(oldpath); } // no return here, we're not done yet.
        if (!fs.existsSync(newpath)) { return fs.mkdirsSync(newpath); }
        fs.renameSync(newpath, tmpspace);
        fs.mkdirsSync(newpath);
        mapDir(tmpspace, function (f, cb) {
            var path = dbFile(f, tmpspace);
            fs.unlink(path, cb);
        }, function (e) {
            _.noop(e);
            fs.rmdir(tmpspace, _.noop);
        });
    }
    root = base;
    fs.mkdirsSync(path.resolve(root, 'mutable/people'));
    fs.mkdirsSync(path.resolve(root, 'mutable/citation'));
    fs.mkdirsSync(path.resolve(root, 'mutable/refs'));
    fs.mkdirsSync(path.resolve(root, 'immutable/thumb'));
    markedDirs.forEach(cleandir);
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
        mapDir(oldpath, function (f, icb) {
            var oldf = dbFile(f, oldpath);
            var newf = dbFile(f, newpath);
            lock(oldf, function (unlock) { // against update of same file
                var ucb = function (e) { unlock(); icb(e); };
                fs.unlink(newf, function (e1) {
                    if (!e1) {
                        stats[labelExist]++;
                        ucb(e1);
                    } else {
                        if (isNoFile(e1)) { e1 = null; }
                        stats[labelDeleted]++;
                        fs.unlink(oldf, function (e2) {
                            if (doCheck) {
                                fs.unlink(thumbFile(f), function (e3) {
                                    fs.unlink(refsFile(f), function (e4) {
                                        ucb(e1 || e2 || (!isNoFile(e3) && e3) || (!isNoFile(e4) && e4));
                                    });
                                });
                            } else {
                                ucb(e1 || e2);
                            }
                        });
                    }
                });
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
    fs.exists(newPath, function (exists) {
        if (exists && !forceData) { return callback(null, null); }
        // It's ok if someone else snuck in and touched newPath in the time between starting fs.exists and it's callback.
        // We'll repeat some work (and the gc results accounting will be slightly inflated), but the results will still be correct.
        readLockFile(oldPath, function (readError, json) {
            if (readError) { return callback(readError); }
            if (!exists) {
                touch(newPath, function (e) {
                    callback(e, JSON.parse(json));
                });
            } else {
                // We could skip the parsing for non-scene places, because the value isn't used (except for it's truthiness).
                callback(null, JSON.parse(json));
            }
        });
    });
}
exports.initialize = initialize;
exports.mark = mark;
exports.sweep = sweep;
