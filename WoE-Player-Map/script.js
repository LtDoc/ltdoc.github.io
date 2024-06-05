// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCo9QPVrLCXS6li_kcTu3e-GOoiiwpHvLs",
    authDomain: "woe-world.firebaseapp.com",
    projectId: "woe-world",
    storageBucket: "woe-world.appspot.com",
    messagingSenderId: "706865712365",
    appId: "1:706865712365:web:e080b1ef45b8d8b27190e4",
    measurementId: "G-789BN2WECG"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

let isAdmin = false;
let selectedMarker = null;

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

// Store markers
const markers = {};

// Function to create or update a marker
function updateMarker(id, position, iconUrl, label) {
    if (markers[id]) {
        markers[id].setLatLng(position);
        markers[id].bindTooltip(label).openTooltip();
    } else {
        const customIcon = new CustomIcon({ iconUrl });
        const markerInstance = L.marker(position, {
            icon: customIcon,
            draggable: isAdmin,
            id
        }).addTo(map);

        markerInstance.bindTooltip(label).openTooltip();

        if (isAdmin) {
            markerInstance.on('dragend', function (event) {
                const marker = event.target;
                const newPosition = marker.getLatLng();
                firebase.database().ref('markers/' + id).set({
                    position: newPosition,
                    iconUrl: marker.options.icon.options.iconUrl,
                    label: marker.getTooltip().getContent()
                });
            });

            markerInstance.on('click', function (event) {
                selectedMarker = markerInstance;
                document.getElementById('marker-label').value = markerInstance.getTooltip().getContent();
                document.getElementById('marker-icon').value = markerInstance.options.icon.options.iconUrl;
                document.getElementById('marker-actions').style.display = 'block';
            });
        }

        markers[id] = markerInstance;
    }
}

// Handle initial marker data from server
firebase.database().ref('markers').on('value', (snapshot) => {
    const data = snapshot.val();
    for (const id in data) {
        updateMarker(id, data[id].position, data[id].iconUrl, data[id].label);
    }
});

// Initialize markers with default positions
const initialMarkers = [
    { id: 'marker1', position: { lat: 250, lng: 250 }, icon: 'assets/image1.png', label: 'Marker 1' },
    { id: 'marker2', position: { lat: 750, lng: 750 }, icon: 'assets/image2.png', label: 'Marker 2' }
];

initialMarkers.forEach(marker => {
    const { id, position, icon, label } = marker;
    firebase.database().ref('markers/' + id).set({ position, iconUrl: icon, label });
    updateMarker(id, position, icon, label);
});

// Login function
function login() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    // Simple hardcoded credentials (for demonstration purposes only)
    if (username === 'admin' && password === 'password') {
        isAdmin = true;
        document.getElementById('login-form').style.display = 'none';
    } else {
        alert('Invalid credentials');
    }
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
            label
        });
    }
}

// Remove selected marker
function removeSelectedMarker() {
    if (selectedMarker) {
        const markerId = selectedMarker.options.id;
        map.removeLayer(selectedMarker);
        firebase.database().ref('markers/' + markerId).remove();
        selectedMarker = null;
        document.getElementById('marker-actions').style.display = 'none';
    }
}
