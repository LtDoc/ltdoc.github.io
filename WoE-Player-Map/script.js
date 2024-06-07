function login() {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    firebase.database().ref('users').orderByChild('username').equalTo(username).once('value', snapshot => {
        const users = snapshot.val();
        if (users) {
            const userId = Object.keys(users)[0];
            const user = users[userId];
            if (user.password === password) {
                window.sharedData.currentUser = username;
                document.getElementById('login-form').style.display = 'none';
                document.getElementById('signup-form').style.display = 'none';
                document.getElementById('map-container').contentWindow.postMessage({ type: 'login', username }, '*');
                // Show admin button if the user is admin
                if (username === 'admin') {
                    window.sharedData.isAdmin = true;
                    document.getElementById('admin-toggle').style.display = 'block';
                }
            } else {
                alert('Invalid credentials');
            }
        } else {
            alert('Invalid credentials');
        }
    }).catch(error => {
        console.error('Error logging in: ', error);
        alert('Invalid credentials');
    });
}

function signup() {
    const username = document.getElementById('signup-username').value;
    const password = document.getElementById('signup-password').value;

    const newUserRef = firebase.database().ref('users').push();
    newUserRef.set({
        username,
        password
    }).then(() => {
        alert('Sign up successful! Please log in.');
        showLogin();
    }).catch(error => {
        console.error('Error signing up: ', error);
        alert('Sign up failed');
    });
}

function showSignup() {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('signup-form').style.display = 'block';
}

function showLogin() {
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('signup-form').style.display = 'none';
}

function updateSelectedMarker() {
    const { selectedMarker, currentUser } = window.sharedData;
    if (selectedMarker) {
        const label = document.getElementById('marker-label').value;
        const iconUrl = document.getElementById('marker-icon').value;
        selectedMarker.setIcon(new CustomIcon({ iconUrl }));
        selectedMarker.unbindTooltip().bindTooltip(label);
        firebase.database().ref('markers/' + selectedMarker.options.id).set({
            position: selectedMarker.getLatLng(),
            iconUrl,
            label,
            userId: currentUser
        }).then(() => {
            console.log(`Marker ${selectedMarker.options.id} updated in Firebase.`);
        }).catch((error) => {
            console.error(`Failed to update marker ${selectedMarker.options.id}: `, error);
        });
    }
}

function removeSelectedMarker() {
    const { selectedMarker } = window.sharedData;
    if (selectedMarker) {
        const markerId = selectedMarker.options.id;
        document.getElementById('map-container').contentWindow.postMessage({ type: 'removeMarker', id: markerId }, '*');
        firebase.database().ref('markers/' + markerId).remove().then(() => {
            console.log(`Marker ${markerId} removed from Firebase.`);
        }).catch((error) => {
            console.error(`Failed to remove marker ${markerId}: `, error);
        });
        window.sharedData.selectedMarker = null;
        document.getElementById('marker-actions').style.display = 'none';
    }
}

function addNewMarker() {
    const id = document.getElementById('new-marker-id').value;
    const label = document.getElementById('new-marker-label').value;
    const iconUrl = document.getElementById('new-marker-icon').value;
    const { currentUser } = window.sharedData;

    firebase.database().ref('markers/' + id).set({
        position: { lat: 3277, lng: 4096 },
        iconUrl,
        label,
        userId: currentUser
    }).then(() => {
        console.log(`Marker ${id} added to Firebase.`);
        document.getElementById('map-container').contentWindow.postMessage({
            type: 'addMarker',
            id: id,
            position: { lat: 3277, lng: 4096 },
            iconUrl: iconUrl,
            label: label
        }, '*');
    }).catch((error) => {
        console.error(`Failed to add marker ${id}: `, error);
    });
}

function adminSignup() {
    const username = document.getElementById('admin-signup-username').value;
    const password = document.getElementById('admin-signup-password').value;
    const markerIds = document.getElementById('admin-signup-markers').value.split(',').map(id => id.trim());

    const newUserRef = firebase.database().ref('users').push();
    newUserRef.set({
        username,
        password
    }).then(() => {
        const updates = {};
        markerIds.forEach(id => {
            updates[`markers/${id}/userId`] = newUserRef.key;
        });
        firebase.database().ref().update(updates).then(() => {
            console.log(`User ${username} created and markers assigned.`);
        }).catch(error => {
            console.error('Error assigning markers: ', error);
        });
        alert('User created and markers assigned.');
    }).catch(error => {
        console.error('Error signing up user: ', error);
        alert('Sign up failed');
    });
}

function removeUser() {
    const username = document.getElementById('remove-user-username').value;

    firebase.database().ref('users').orderByChild('username').equalTo(username).once('value', snapshot => {
        const users = snapshot.val();
        if (users) {
            const userId = Object.keys(users)[0];
            const updates = {};
            updates[`users/${userId}`] = null; // Remove user
            firebase.database().ref('markers').orderByChild('userId').equalTo(userId).once('value', (snapshot) => {
                const data = snapshot.val();
                if (data) {
                    Object.keys(data).forEach(markerId => {
                        updates[`markers/${markerId}`] = null; // Remove marker
                    });
                    firebase.database().ref().update(updates).then(() => {
                        console.log(`User ${username} and associated markers removed.`);
                        alert('User and markers removed.');
                    }).catch(error => {
                        console.error('Error removing user and markers: ', error);
                    });
                }
            });
        } else {
            alert('No user found with that username.');
        }
    }).catch(error => {
        console.error('Error fetching user by username: ', error);
        alert('Failed to fetch user by username.');
    });
}

function toggleAdminPanel() {
    const adminPanel = document.getElementById('admin-panel');
    if (adminPanel.style.display === 'none' || adminPanel.style.display === '') {
        adminPanel.style.display = 'block';
    } else {
        adminPanel.style.display = 'none';
    }
}

window.addEventListener('message', (event) => {
    if (event.data.type === 'login') {
        window.sharedData.currentUser = event.data.username;
        loadUserMarkers();
    }
});
