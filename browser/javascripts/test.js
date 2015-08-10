"use strict";
/*jslint browser: true, devel: true, vars: true, plusplus: true */
// Test suite for Kilroy. Requires Jasamine 2.0. (1.3 had a different mechanism for asynchronicity.)
var jasmine, describe, it, beforeEach, expect, runs;
var SCENE, THING, USER, selectedObjectPath, sendUnity, UPDATED, UPDATE_CALLBACKS, startUpdate, tabNav;
// We're relying on these functions to be correct (used in implementation and in test suite).
var kilroyURL, thumbnailURL, addTimestamp;

function getData() { // When ready, the truthy value is the data about the in-scene activity that just completed.
    if (!UPDATED || (!SCENE.nametag && !THING.nametag)) { return false; }
    return {sceneIdtag: SCENE.idtag, sceneNametag: SCENE.nametag, sceneIdvtag: SCENE.idvtag, sceneTimestamp: SCENE.timestamp,
            objectNametag: THING.nametag, objectIdtag: THING.idtag, userNametag: USER.nametag, userIdtag: USER.idtag};
}
// Pass if string contains substring. Substring can be empty (meaning string just has to be defined), or undefined (meaning string should not be defined).
// Substring can also be a function(string) that generates a substring/empty/undefined value as described above.
function shouldContain(string, substring) {
    if ('function' === typeof substring) { substring = substring(); }
    if (substring) {
        expect(string).toContain(substring);
    } else if (substring === undefined) {
        expect(string).toBeFalsy();
    } else {
        expect(string).toBeDefined();
    }
}
function labelForContain(id, getterName, substring) { // answer a descriptive string suitable for a shouldContain test label.
    if (getterName === 'title') { getterName = 'tooltip'; } // because otherwise it's just too confusing to read.
    var stem = 'has ';
    if ('string' === typeof id) { stem += id + ' element '; } else { stem += 'element '; }
    if ('function' === typeof substring) {
        return stem + 'with proper ' + getterName;
    }
    if (substring === undefined) {
        return stem + 'without ' + getterName;
    }
    if (substring) {
        return stem + 'with ' + getterName + ' containing "' + substring + '"';
    }
    return stem + 'with ' + getterName;
}
function has(elt, attributeName, substring) { // Passes if elt (or elt() if it is a function) has an attributed that shouldContain substring.
    it(labelForContain(elt, attributeName, substring), function () {
        if ('string' === typeof elt) {
            elt = document.getElementById(elt);
        } else if ('function' === typeof elt) {
            elt = elt();
        }
        shouldContain(elt.getAttribute(attributeName), substring);
    });
}
// Defines a test suite named name.
// Does not start until pretest() is true.
// data() is then called once to produce the data.
// The tests don't run until then.
function onSelection(name, pretest, data, moreTests, expectedHistory, historyNth, action) {
    var testCbs = [], selected, inited;
    describe(name, function () {
        var cockTrigger = function () { // Arrange to do all testCbs on the first UPDATE for which our pretest() is true.
            UPDATE_CALLBACKS.push(function () {
                if (!pretest || pretest()) {
                    var fs = testCbs;
                    testCbs = null;
                    fs.forEach(function (cb) { cb(); });
                } else {
                    cockTrigger();
                }
            });
        };
        beforeEach(function (done) {
            if (!inited) { // add to UPDATE_CALLBACKS once, but not until it is initialized.
                cockTrigger();
                inited = true;
            }
            var cb = function () {
                if (!selected) { selected = data(); }
                done();
            };
            if (testCbs) {
                testCbs.push(cb);
            } else {
                cb();
            }
        });
        var nametag = function () { return THING.nametag || SCENE.nametag; };
        //var selectedURL = function () { return kilroyURL(selected.sceneIdtag, selected.objectIdtag); }; // used by 'email' test
        it('has title containing nametag', function () {
            expect(document.title).toContain(nametag());
        });
        has('input', 'title', 'chat');
        it('has status element containging user name', function () {
            expect(document.getElementById('status').innerHTML).toContain(selected.userNametag || 'Connecting');
        });
        has('dropzone', 'title', '');
        describe('social stuff', function () {
            // We can't add tooltips to FB internal buttons. This tooltip is on the containing div.
            has('greybox', 'title', function () { return selected.userNametag ? undefined : 'Facebook'; });
            has('fbLogout', 'title', 'Facebook');
            has('metadataTab', 'title', 'Facebook');
            has('publicLabel', 'onclick', 'softLink');
            has('publicLabel', 'title', 'are now');
            // has('email', 'href', function () { return selectedURL().replace('public', 'email'); }); // I'm flipflooping about whether I want this button present.
        });
        describe('editing stuff', function () {
            has('propertiesTab', 'title', 'properties');
            it('has editable tagname', function () {
                var elt = document.getElementById('tag0');
                var val = elt.value;
                var nt = nametag();
                expect(val).toBe(nt);
            });
            has('tag0', 'type', 'text');
            it('uses a scene graph path', function () {
                expect(selectedObjectPath).toContain(selected.sceneIdtag);
                if (selected.objectIdtag) {
                    expect(selectedObjectPath).toContain(selected.objectIdtag);
                }
            });
            has('delete', 'title', 'Delete');
            has('delete', 'onclick', 'deleteObject');
            has('export', 'title', 'Download');
            it('export button has download path for objects', function () {
                var href = document.getElementById('export').getAttribute('href');
                expect(href).toContain('/xport/');
                if (selected.objectIdtag && selected.objectIdtag !== selected.sceneIdtag) {
                    expect(href).toContain(selected.objectIdtag);
                } else { // We might decide to let this be empty rather than providing a zip of the whole scene, but for now, we allow it.
                    expect(href).toContain(selected.sceneIdtag);
                }
            });
            has('import', 'title', 'file');
            has('import', 'onclick', "getElementById('files').click()");
            has('files', 'onchange', 'handleFileSelect');
            has('files', 'style', 'display:none');
            has('files', 'type', 'file');
            has('files', 'accept', 'image');
            has('pos.x', 'onchange', 'setPositionX');
            has('pos.y', 'onchange', 'setPositionY');
            has('pos.z', 'onchange', 'setPositionZ');
            has('rot.x', 'onchange', 'setRotationX');
            has('rot.y', 'onchange', 'setRotationY');
            has('rot.z', 'onchange', 'setRotationZ');
            has('size.x', 'onchange', 'setSizeX');
            has('size.y', 'onchange', 'setSizeY');
            has('size.z', 'onchange', 'setSizeZ');

            has('pos.x', 'type', 'number');
            has('pos.y', 'type', 'number');
            has('pos.z', 'type', 'number');
            has('rot.x', 'type', 'number');
            has('rot.y', 'type', 'number');
            has('rot.z', 'type', 'number');
            has('size.x', 'type', 'number');
            has('size.y', 'type', 'number');
            has('size.z', 'type', 'number');
        });
        describe('object lists', function () {
            has('relatedTab', 'title', 'Related');
            has('historyTab', 'title', 'history');
            describe('new history row', function () {
                var history, cells, getCell = function (index) { return cells[index].firstChild; }, hdata;
                it('has five cells', function () {
                    history = document.getElementById('historyBody');
                    cells = historyNth ? history.childNodes[historyNth].childNodes : history.firstChild.childNodes;
                    console.log('FIXME', name, history, history.firstChild, history.childNodes);
                    hdata = expectedHistory || selected;
                    expect(cells.length).toBe(5);
                });
                describe('thumbnail', function () {
                    var thumb = function () { return getCell(0); };
                    has(thumb, 'title', 'social');
                    has(thumb, 'src', function () {
                        return thumbnailURL((!hdata.objectIdtag || (hdata.objectIdtag === hdata.sceneIdtag))
                                            ? hdata.sceneIdvtag : hdata.objectIdtag);
                    });
                    has(thumb, 'onclick', '');
                    has(thumb, 'ondragstart', '');
                });
                it('identifies object if any', function () {
                    var object = getCell(1);
                    shouldContain(object.getAttribute('kref'), kilroyURL(hdata.sceneIdtag, hdata.objectIdtag));
                    shouldContain(object.innerHTML, hdata.objectNametag);
                });
                it('identifies this scene', function () {
                    var scene = getCell(2);
                    shouldContain(scene.getAttribute('kref'), kilroyURL(hdata.sceneIdtag));
                    shouldContain(scene.innerHTML, hdata.sceneNametag);
                });
                it('identifies timestamp', function () {
                    var object = getCell(3);
                    shouldContain(object.innerHTML, function () { return new Date(parseInt(hdata.objectTimestamp || hdata.sceneTimestamp, 10)).toLocaleString(); });
                    shouldContain(object.getAttribute('kref'), addTimestamp(kilroyURL(hdata.sceneIdtag, hdata.objectIdtag), hdata.sceneTimestamp));
                });
                it('identifies activity', function () {
                    shouldContain(getCell(4).innerHTML, action || (expectedHistory ? expectedHistory.action : name)); // name of this test suite, e.g., 'entry'
                });
            });
        });
        if (moreTests) { moreTests(); }
    });
}

describe('kilroy', function () {
    it('has no initial-entry export href so crawlers do not waste time', function () {
        expect(document.getElementById('export').getAttribute('href')).toBeFalsy();
    });
    var firstData, secondData, thirdData;
    onSelection('entry', null, function () { firstData = getData(); return firstData; }, function () {
        it('allows tab', function () {
            UPDATE_CALLBACKS.push(function () { secondData = getData(); });
            tabNav();
            expect(true).toBeTruthy();
        });
    });
    onSelection('go', function () {
        return secondData;
    }, function () {
        return secondData;
    }, function () {
        it('has different results than on entry', function () {
            expect(secondData.objectIdtag).not.toBe(firstData.objectIdtag);
        });
        it('allows back', function () {
            UPDATE_CALLBACKS.push(function () { thirdData = getData(); });
            window.history.back();
        });
    });
    onSelection('back', function () {
        return thirdData;
    }, function () {
        return thirdData;
    }, function () {
        it('has the same results as on entry', function () {
            expect(getData().objectIdtag).toBe(firstData.objectIdtag);
            console.log('test data', firstData, secondData, thirdData);
        });
    }, secondData, 1, 'entry');
});
