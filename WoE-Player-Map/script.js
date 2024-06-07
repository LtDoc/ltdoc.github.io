let currentUser = null;

// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCo9QPVrLCXS6li_kcTu3e-GOoiiwpHvLs",
    authDomain: "woe-world.firebaseapp.com",
    databaseURL: "https://woe-world-default-rtdb.firebaseio.com",
    projectId: "woe-world",
    storageBucket: "woe-world.appspot.com",
    messagingSenderId: "706865712365",
    appId: "1:706865712365:web:e080b1ef45b8d8b27190e4",
    measurementId: "G-789BN2WECG"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// Ensure the users table exists
function ensureUsersTable() {
    database.ref('users').once('value', snapshot => {
        if (!snapshot.exists()) {
            database.ref('users').set({});
        }
    }).catch(error => {
        console.error('Error ensuring users table exists:', error);
    });
}

// Login function
function login() {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    firebase.database().ref('users').orderByChild('username').equalTo(username).once('value', snapshot => {
        const users = snapshot.val();
        if (users) {
            const userId = Object.keys(users)[0];
            const user = users[userId];
            if (user.password === password) {
                currentUser = username;
                document.getElementById('landing-page').style.display = 'none';
                document.getElementById('map-container').style.display = 'block';
                // Show admin button if the user is admin
                if (username === 'admin') {
                    isAdmin = true;
                    document.getElementById('admin-button').style.display = 'block';
                }
                // Make markers draggable if the user is admin
                for (const id in markers) {
                    markers[id].options.draggable = true;
                    markers[id].dragging.enable();
                }
                loadUserMarkers();
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

// Sign up function
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

// Show sign up form
function showSignup() {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('signup-form').style.display = 'block';
}

// Show login form
function showLogin() {
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('signup-form').style.display = 'none';
}

// Load markers relevant to the logged-in user
function loadUserMarkers() {
    if (!currentUser) return;  // Ensure currentUser is set
    firebase.database().ref('markers').orderByChild('userId').equalTo(currentUser).on('value', (snapshot) => {
        const data = snapshot.val();
        console.log("User marker data loaded from Firebase: ", data);
        if (data) {
            for (const id in data) {
                createOrUpdateMarker(id, data[id].position, data[id].iconUrl, data[id].label);
            }
        }
    });
}

// Toggle admin panel
function toggleAdminPanel() {
    const adminPanel = document.getElementById('admin-panel');
    if (adminPanel.style.display === 'none' || adminPanel.style.display === '') {
        adminPanel.style.display = 'block';
    } else {
        adminPanel.style.display = 'none';
    }
}

// Admin sign up function
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

// Remove user function
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
