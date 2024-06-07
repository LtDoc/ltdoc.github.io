// Ensure Firebase is initialized before using it
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

let isAdmin = false;
let selectedMarker = null;
let markers = {};

// Initialize the map
const map = L.map('map-container', {
    center: [0, 0], // Center of the image
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

// Add new marker
function addNewMarker() {
    const id = document.getElementById('new-marker-id').value;
    const label = document.getElementById('new-marker-label').value;
    const iconUrl = document.getElementById('new-marker-icon').value;
    const center = map.getCenter(); // Get the center of the visible map

    firebase.database().ref('markers/' + id).set({
        position: center,
        iconUrl,
        label,
        userId: currentUser
    }).then(() => {
        console.log(`Marker ${id} added to Firebase.`);
        createOrUpdateMarker(id, center, iconUrl, label);
    }).catch((error) => {
        console.error(`Failed to add marker ${id}: `, error);
    });
}
