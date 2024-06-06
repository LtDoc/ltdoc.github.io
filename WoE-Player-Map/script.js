let isAdmin = false;
let selectedMarker = null;

// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCo9QPVrLCXS6li_kcTu3e-GOoiiwpHvLs",
    authDomain: "woe-world.firebaseapp.com",
    databaseURL: "https://woe-world.firebaseio.com",  // Ensure this URL is correct
    projectId: "woe-world",
    storageBucket: "woe-world.appspot.com",
    messagingSenderId: "706865712365",
    appId: "1:706865712365:web:e080b1ef45b8d8b27190e4",
    measurementId: "G-789BN2WECG"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

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
function createMarker(id, position, iconUrl, label) {
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
        console.log(`Marker ${id} dragged to ${newPosition}`);
        // Here you would save the new position to Firebase
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

// Initialize markers with default positions
const initialMarkers = [
    { id: 'marker1', position: { lat: 250, lng: 250 }, icon: 'assets/image1.png', label: 'Marker 1' },
    { id: 'marker2', position: { lat: 750, lng: 750 }, icon: 'assets/image2.png', label: 'Marker 2' }
];

initialMarkers.forEach(marker => {
    const { id, position, icon, label } = marker;
    createMarker(id, position, icon, label);
});

// Login function
function login() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    // Simple hardcoded credentials (for demonstration purposes only)
    if (username === 'admin' && password === 'password') {
        isAdmin = true;
        document.getElementById('login-form').style.display = 'none';
        // Make markers draggable if the user is admin
        for (const id in markers) {
            markers[id].options.draggable = true;
            markers[id].dragging.enable();
        }
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
        
        // Here you would save the updated marker details to Firebase
    }
}

// Remove selected marker
function removeSelectedMarker() {
    if (selectedMarker) {
        const markerId = selectedMarker.options.id;
        map.removeLayer(selectedMarker);
        // Here you would remove the marker from Firebase
        selectedMarker = null;
        document.getElementById('marker-actions').style.display = 'none';
    }
}
