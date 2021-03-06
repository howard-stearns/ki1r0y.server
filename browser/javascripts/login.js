"use strict";
/*jslint browser: true, devel: true, vars: true, plusplus: true, forin: true */
/// Provides doLogin handler for FB login status change, and doLogout handler for fake FB logout button.
/// Copyright (c) 2013 Beyond My Wall. All rights reserved until we get a clue.
/// The Facebook API is copyright by Facebook.
var FB, SCENE, enterIfReady, updateUser, dimension, logEvent, timing, get; // defined elsewhere

// We want set with the right dimensions once we have them, so that all page views have the right dimensions.
// So we don't send
//    ga('send', 'pageview');
// now at load time, but instead begin bounce calculations by sending a non-page-count event now...
logEvent('admin', 'entry', location.pathname);
// ... and later send an event at 'doLogin', which gives us all the initial bounce events by page (pre dimensions).

function onLogout(response) {  // Callback from FB after logout.
    console.log('onLogout', response);
    window.location.reload();  // Force fb login button to actually show login, get out of scene, etc.
}
function onMe(response) {      // Handler for FB.api user data.
    console.log('onMe', response);
    // Use best full name. Facebook has deprecated the use of the unique-but-not-permanent username, and no longer supplies it in user responses.
    var nametag = response.name_format ||
        response.name ||
        (response.first_name && response.last_name && (response.first_name + ' ' + response.last_name)) ||
        response.first_name ||
        response.last_name;
    enterIfReady(null, response.id, nametag);
    // From here down is common to all that use FB login.
    var logout = document.getElementById('fbLogout');
    logout.setAttribute('title',
                        'You are logged into Facebook as ' + response.name
                        + '. You can log out or change identities with the Logout button.');
    logout.style.display = 'inline-block';
    dimension('userId', response.id); // FIXME remove after beta. (Track only aggregates.)
    dimension('fbGender', response.gender);
    logEvent('admin', 'user', response.id);
    timing('admin', 'user');
    // Update user info. Probably never changes after the first time, but we still need it that first time 
    // (in order to serve people pages). And it _could_ change... And scene needs to be updated anyway.
    // Note that onUserData => enterIfReady => records USER.idtag
    updateUser({
        firstname: response.first_name,
        lastname: response.last_name,
        nametag: nametag,
        description: response.about,
        scene: SCENE.idtag, // so that last-visited can be updated
        gender: response.gender // Required by OpenGraph
    });
}
function doLogin(response) {   // Handler for FB login status change.
    console.log('doLogin', response);
    var display = 'block';
    switch (response.status) {
    case 'connected':
        document.getElementById('greybox').removeAttribute('title');
        if (FB) {
            FB.api('/me', onMe);
        } else { // Dummy for testing
            onMe({name: 'local trevor', id: '100004567501627'});
            //onMe({name: 'howard local', id: '100000015148499'});
            //onMe({name: 'local kilroy', id: '100007663687854'});
        }
        break;
    case 'unknown': // logged out
        display = 'none';
        break;
    case 'not_authorized':
        document.getElementById('status').innerHTML = "Waiting for you to approve the \"ki1r0y\" app. Click the 'Login' button and Facebook will ask you in a pop-up to confirm that you want to use this app.";
        break;
    }
    dimension('scene', SCENE.idtag);
    logEvent('admin', 'login', response.status);
    document.getElementById('authedInput').style.display = display;
}
function doLogout() {          // Click handler for our FB-ish logout button.
    console.log('doLogout');
    document.getElementById('authedInput').style.display = 'none';
    get('/logout'); // Clear any server-side session
    if (FB) { FB.logout(onLogout); }
}
