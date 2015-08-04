"use strict";
/*jslint browser: true, vars: true, plusplus: true */
/// Sets up interface to chat and search.
/// Copyright (c) 2013 Beyond My Wall. All rights reserved until we get a clue.
var io, console, setRelated, logEvent, dimension;  // externally defined
var connection = io.connect(); // socket.io connection. Receives 'connect' event.

var contentElt, inputElt, statusElt; // document elements we use.

///////////////////////////////////////////////////////////////////////////////////////////////
// Basic message handling.

// Messages are identified by a session-unique tag. This removes the specified message, if any.
// idtag does not have to be present.
// To preserve implementation flexibility, idtag should be unique among all document element id attributes.
function removeMessage(idtag) {
	if (!idtag) { return; }
	var i, child, nodes = contentElt.childNodes;
	for (i = 0; i < nodes.length; i++) {
		child = nodes[i];
		if (child.id === idtag) {
			console.log('Removing earlier message <' + idtag.slice(0, 20) + ">: '" + child.textContent + "'.");
			// should we addClass(child, 'hidden') instead, or animate dissapearance?
			contentElt.removeChild(child);
			return;
		}
	}
	//console.log('failed to remove earlier message ' + idtag);
}
function addMessage(msg, doKillTyping) {
	//console.log('addMessage', msg, doKillTyping);
	var author = msg.author, message = msg.text, color = msg.color, dt = new Date(msg.time);
	// TODO: show fb picture
	if (msg.typing === 'start') {
		message = '...'; // This is not a blinker. Too distracting.
	} else if (doKillTyping) {
		removeMessage(msg.idtag);
	}
	if (msg.typing !== 'end') {
		var row = document.createElement('p');
		var time = dt.toLocaleTimeString();
		// Or alt:
		// (dt.getHours() < 10 ? '0' + dt.getHours() : dt.getHours()) + ':' + (dt.getMinutes() < 10 ? '0' + dt.getMinutes() : dt.getMinutes())
		row.id = msg.idtag;
		row.className = 'imMessage';
		row.innerHTML = '<span style="color:' + color + '">'
			+ author + '</span>'
			// + '<span style="color:Gray">@' + time + '</span>'
			+ ': ' + message;
		row.setAttribute('title', ((author === 'Ki1r0y') ? 'Message from system' : 'Message from ' + author) + ' at ' + time + '.');
		contentElt.appendChild(row);
		contentElt.scrollTop = contentElt.scrollHeight;
	}
}
var blinker;
function blink(check) { // Makes blink tags blink. Stops when there are no such tags. Use sparingly!
	if (check && blinker) { return; } // without starting a new one
    var i, s, blinks = document.getElementsByTagName('blink');
	if (!blinks.length) { blinker = undefined; return; }
    for (i = blinks.length - 1; i >= 0; i--) {
		s = blinks[i];
		s.style.visibility = (s.style.visibility === 'visible') ? 'hidden' : 'visible';
    }
    blinker = window.setTimeout(blink, 1000);
}

///////////////////////////////////////////////////////////////////////////////////////////////
// Our browser-side API, used from other browser code or upon the corresponding message type from the server.

// Occurs on response to join. (We could tell plugin if we wanted to.)
function setAvatarColor(color) {
	statusElt.style.color = color;
	inputElt.removeAttribute('disabled');
	//inputElt.focus();
	// from now on, user can start sending messages
}
function doHistory(history) {
	var i;
	for (i = 0; i < history.length; i++) { addMessage(history[i]); }
}
function addLocalMessage(message, idtag) {
	addMessage({
		time: (new Date()).getTime(),
		text: '<i>' + message + '</i>',
		author: 'Ki1r0y',
		color: 'Silver',
		idtag: idtag
	});
}
var onceOnlies = {}; // State for sayOnce/clearOnce.
function sayOnce(msg, idtag) { // Tell the user msg, but only the first time it's been given (with this function).
	idtag = idtag || msg;
	if (!onceOnlies[idtag]) {
		addLocalMessage(msg, idtag);
		onceOnlies[idtag] = idtag;
	}
}
function clearOnce(idtag) { // Remove the given user msg, if it was given with sayOnce. 
	console.log('clearOnce', idtag, onceOnlies[idtag]);
	if (onceOnlies[idtag] && (onceOnlies[idtag] !== true)) {
		removeMessage(idtag);
		onceOnlies[idtag] = true;
	}
}

// I don't know yet what variety of situations we'll have that fail.
// For now, funnel them all through here.
function errorMessage(msg) {
	addLocalMessage('<span style="color:#a85a74">' + msg + '</span>', msg); // color is FB button triad 1
	logEvent('system', 'error', msg);
}
// Advice from ki1r0y to user. Keep just the latest one, so that transcript doesn't fill with annoying messages.
function advice(msg) {
	removeMessage(msg);
	addLocalMessage(msg, msg);
	logEvent('system', 'advice', msg);
}

function statusMessageStart(msg) {
	addLocalMessage(msg + '..<blink>.</blink>', msg);
	blink(true);
}
function statusMessageUpdate(msg, update, progress) {
	if (!update && progress < 1) { return; } // FIXME: update a progress bar. N.B.: we don't call it this way yet.
	removeMessage(msg);
	addLocalMessage(update || (msg + ': done'), msg);
	// IWBNI maybe we removed msg some time after progress >= 1.
	// It depends on how we end up using this. Currently, just file upload, which we can leave.
}

//////////////////////////////////////////////////////////////////////////////////////////////////
// Setup
function ensureChatElements() { 
	if (contentElt) { return; }
	inputElt = document.getElementById('input');
	console.log('ensureChatElements');
	//if (!inputElt) { return setTimeout(ensureChatElements, 100); } // FIXME remove. Better not be happening, else we'll be relying on eg. statusElt being set.
	contentElt = document.getElementById('content');
	statusElt = document.getElementById('status');

	// Can't do this until the inputElt is present. 
	// No need to worry about these firing before joining, becaus the inputElt is initially disabled.
	var isTyping = false;
	inputElt.onkeypress = function (e) { //keypress so as not to be distracted by shift, tab, etc.
		if (e.keyCode === 13) {
			var msg = inputElt.value;
			var wasTyping = isTyping;
			isTyping = false;
			if (!msg) {
				if (wasTyping) { connection.emit('typing', false); }
				return;
			}
			connection.send(msg);
			logEvent('communication', 'msg', msg);
			inputElt.value = '';
			// disable the input field to make the user wait until server sends back response
			inputElt.setAttribute('disabled', 'disabled');
		} else if (!isTyping) {
			isTyping = true;
			connection.emit('typing', true);
		}
	};
	inputElt.onkeydown = function (e) { // Just for backspace
		if ((inputElt.value.length <= 1) && ((e.keyCode === 8) || (e.keyCode === 46))) {
			isTyping = false;
			connection.emit('typing', false);
		}
	};
}

var joined, connected, userIdtagged, userNametagged, sceneIdtagged; // chat state info
// Called from either of the below, in indeterminate order. When we have enough info
// to actually join, this does the work. Caches info for later.
function joinChatIfPossible(userIdtag, userNametag, sceneIdtag) {
	ensureChatElements();
	// Can't be done until we are connected and named. Could happen in any order,
	// but is mostly likely to get the name last (from fb).
	console.log('joinChatIfPossible userNametag:', userNametag, 'sceneIdtag:', sceneIdtag, joined);
	if (joined) { return; }
    userIdtagged = userIdtag || userIdtagged;
	userNametagged = userNametag || userNametagged;
	sceneIdtagged = sceneIdtag || sceneIdtagged;
	statusElt.innerHTML = (userNametagged || 'Log In Required') + ': ';
	if (connected && userNametagged) {
		joined = true;
		// FIXME: still needs VB ActiveX plugin detection on IE.
		var unity = navigator.mimeTypes && navigator.mimeTypes["application/vnd.unity"];
		var plugin = unity && unity.enabledPlugin && navigator.plugins && navigator.plugins["Unity Player"];
		var pluginData = plugin.description && plugin.description.match(/ (\d+.\d+\S+). /);
		var pluginVersion = plugin && ((pluginData && pluginData.length && pluginData[1]) || 'unknown version');
		dimension('plugin', pluginVersion);
		connection.emit('join', {idtag: userIdtagged, nametag: userNametagged, room: sceneIdtagged, plugin: pluginVersion});
	}
}
function chatLogin(userIdtag, userNametag, sceneIdtag) { // Entry point from FB login.
	document.getElementById('authedInput').style.display = "block";
	joinChatIfPossible(userIdtag, userNametag, sceneIdtag);
}
connection.on('connect', function (/*ignoredSocket*/) { // Triggered asynchronously by io.connect at load time.
	connected = true;
	// Set up handlers for events from our server.
	connection.on('color', setAvatarColor);
	connection.on('history', doHistory);
	connection.on('im', function (message) {
		inputElt.removeAttribute('disabled'); // let the user write another message
		addMessage(message, 'doKillTyping');
    });
	connection.on('related', setRelated); // Should we create a timing event to log msg->related time?
	connection.on('error', errorMessage);
	joinChatIfPossible(); // In case FB login was faster than socket.io connect.
});

