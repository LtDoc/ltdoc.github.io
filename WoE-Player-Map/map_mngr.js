const { isAdmin, markers, currentUser } = window.sharedData;

// Function to create or update a marker
function createOrUpdateMarker(id, position, iconUrl, label) {
    if (markers[id]) {
        markers[id].setLatLng(position);
        markers[id].setIcon(new CustomIcon({ iconUrl }));
        markers[id].unbindTooltip();
    } else {
        const customIcon = new CustomIcon({ iconUrl });
        const markerInstance = L.marker(position, {
            icon: customIcon,
            draggable: isAdmin,
            id,
        }).addTo(map);

        // Handle marker dragging
        markerInstance.on('dragstart', function () {
            map.dragging.disable(); // Disable map dragging while marker is being dragged
            markerInstance.closeTooltip(); // Close the tooltip while dragging
        });

        markerInstance.on('dragend', function (event) {
            map.dragging.enable(); // Re-enable map dragging once marker drag is complete

            const marker = event.target;
            const newPosition = marker.getLatLng();

            // Ensure marker is within bounds
            if (!map.getBounds().contains(newPosition)) {
                marker.setLatLng(position);
                return;
            }

            window.parent.postMessage({
                type: 'updateMarker',
                id: id,
                position: newPosition,
                iconUrl: marker.options.icon.options.iconUrl,
                label: label
            }, '*');
        });

        markerInstance.on('click', function (event) {
            if (event.stopPropagation) event.stopPropagation(); // Prevent map click event
            if (isAdmin) {
                window.sharedData.selectedMarker = markerInstance;
                window.parent.postMessage({
                    type: 'selectMarker',
                    id: id,
                    label: label,
                    iconUrl: iconUrl
                }, '*');
            }
        });

        // Show tooltip on right-click
        markerInstance.on('contextmenu', function (event) {
            event.preventDefault();
            markerInstance.bindTooltip(label).openTooltip();
        });

        // Prevent the marker's mousedown event from propagating to the map
        markerInstance.on('mousedown', function (event) {
            if (event.stopPropagation) event.stopPropagation(); // Prevent map mousedown event
        });

        markers[id] = markerInstance;
    }
}

window.addEventListener('message', (event) => {
    const data = event.data;
    if (data.type === 'addMarker') {
        createOrUpdateMarker(data.id, data.position, data.iconUrl, data.label);
    } else if (data.type === 'removeMarker') {
        if (markers[data.id]) {
            map.removeLayer(markers[data.id]);
            delete markers[data.id];
        }
    } else if (data.type === 'updateMarker') {
        createOrUpdateMarker(data.id, data.position, data.iconUrl, data.label);
    } else if (data.type === 'login') {
        window.sharedData.currentUser = data.username;
        window.sharedData.isAdmin = data.username === 'admin';
        loadUserMarkers();
    }
});

function loadUserMarkers() {
    const { currentUser } = window.sharedData;
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

// Initialize the map
const map = L.map('map', {
    center: [3277, 4096], // Center of the image (assuming the image is 8192x6554 pixels)
    zoom: 0.25, // Adjust initial zoom level
    crs: L.CRS.Simple, // Use simple coordinate system
    maxBounds: [[0, 0], [6554, 8192]], // Set the bounds to prevent panning outside the image
    maxBoundsViscosity: 1.0 // Fully constrain the map to the bounds
});

// Load the map image
const bounds = [[0, 0], [6554, 8192]]; // Assuming the image is 8192x6554 pixels
const image = L.imageOverlay('assets/high_res_image.png', bounds).addTo(map);

// Fit the map to the image bounds
map.fitBounds(bounds);

// Custom icon class
const CustomIcon = L.Icon.extend({
    options: {
        iconSize: [100, 100],
        iconAnchor: [50, 50], // Anchor in the middle of the icon
    },
});
