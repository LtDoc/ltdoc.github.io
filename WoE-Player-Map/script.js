let isAdmin = false;
let selectedMarker = null;
let currentUser = null;
let markers = {};

// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCo9QPVrLCXS6li_kcTu3e-GOoiiwpHvLs",
    authDomain: "woe-world.firebaseapp.com",
    databaseURL: "woe-world-default-rtdb.firebaseio.com",
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

// Initialize the map
const map = L.map('map-container', {
    center: [0, 0],
    zoom: 1,
    crs: L.CRS.Simple // Use simple coordinate system
});

// Load the map image
const bounds = [[0, 0], [1080, 1500]]; // Assuming the image is 1080x1500 pixels
const image = L.imageOverlay('assets/high_res_image.png', bounds).addTo(map);

// Fit the map to the image bounds
map.fitBounds(bounds);

// Custom icon class
const CustomIcon = L.Icon.extend({
    options: {
        iconSize: [100, 100],
        iconAnchor: [50, 50] // Anchor in the middle of the icon
    }
});

// Function to create or update a marker
function createOrUpdateMarker(id, position, iconUrl, label) {
    if (markers[id]) {
        markers[id].setLatLng(position);
        markers[id].setIcon(new CustomIcon({ iconUrl }));
        markers[id].bindTooltip(label).openTooltip();
    } else {
        const customIcon = new CustomIcon({ iconUrl });
        const markerInstance = L.marker(position, {
            icon: customIcon,
            draggable: isAdmin,
            id
        }).addTo(map);

        markerInstance.bindTooltip(label).openTooltip();

        markerInstance.on('dragend', function (event) {
            const marker = event.target;
            const newPosition = marker.getLatLng();
            firebase.database().ref('markers/' + id).set({
                position: newPosition,
                iconUrl: marker.options.icon.options.iconUrl,
                label: marker.getTooltip().getContent(),
                userId: currentUser
            }).then(() => {
                console.log(`Marker ${id} position saved to Firebase.`);
            }).catch((error) => {
                console.error(`Failed to save marker ${id} position: `, error);
            });
        });

        markerInstance.on('click', function (event) {
            if (isAdmin) {
                selectedMarker = markerInstance;
                document.getElementById('marker-label').value = markerInstance.getTooltip().getContent();
                document.getElementById('marker-icon').value = markerInstance.options.icon.options.iconUrl;
                document.getElementById('marker-actions').style.display = 'block';
            }
        });

        markers[id] = markerInstance;
    }
}

// Handle initial marker data from server
firebase.database().ref('markers').on('value', (snapshot) => {
    const data = snapshot.val();
    console.log("Initial marker data loaded from Firebase: ", data);
    if (data && currentUser) {
        for (const id in data) {
            if (data[id].userId === currentUser || data[id].partyId === currentUser) {
                createOrUpdateMarker(id, data[id].position, data[id].iconUrl, data[id].label);
            }
        }
    }
});

// Initialize markers with default positions if not already in Firebase
const initialMarkers = [
    { id: 'marker1', position: { lat: 250, lng: 250 }, icon: 'assets/image1.png', label: 'Marker 1' },
    { id: 'marker2', position: { lat: 750, lng: 750 }, icon: 'assets/image2.png', label: 'Marker 2' }
];

initialMarkers.forEach(marker => {
    const { id, position, icon, label } = marker;
    firebase.database().ref('markers/' + id).once('value', (snapshot) => {
        if (!snapshot.exists()) {
            firebase.database().ref('markers/' + id).set({ position, iconUrl: icon, label });
        }
    });
});

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

// Update selected marker
function updateSelectedMarker() {
    if (selectedMarker) {
        const label = document.getElementById('marker-label').value;
        const iconUrl = document.getElementById('marker-icon').value;

        selectedMarker.setIcon(new CustomIcon({ iconUrl }));
        selectedMarker.bindTooltip(label).openTooltip();

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

// Remove selected marker
function removeSelectedMarker() {
    if (selectedMarker) {
        const markerId = selectedMarker.options.id;
        map.removeLayer(selectedMarker);
        firebase.database().ref('markers/' + markerId).remove().then(() => {
            console.log(`Marker ${markerId} removed from Firebase.`);
        }).catch((error) => {
            console.error(`Failed to remove marker ${markerId}: `, error);
        });
        selectedMarker = null;
        document.getElementById('marker-actions').style.display = 'none';
    }
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

// Add new marker
function addNewMarker() {
    const id = document.getElementById('new-marker-id').value;
    const label = document.getElementById('new-marker-label').value;
    const iconUrl = document.getElementById('new-marker-icon').value;
    const position = { lat: map.getCenter().lat, lng: map.getCenter().lng }; // Default position

    firebase.database().ref('markers/' + id).set({
        position,
        iconUrl,
        label,
        userId: currentUser
    }).then(() => {
        console.log(`Marker ${id} added to Firebase.`);
        createOrUpdateMarker(id, position, iconUrl, label);
    }).catch((error) => {
        console.error(`Failed to add marker ${id}: `, error);
    });
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

// Ensure the users table exists on load
ensureUsersTable();
