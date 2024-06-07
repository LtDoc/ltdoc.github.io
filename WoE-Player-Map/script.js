const adminIPs = ['24.57.218.92'];

// Check if the user's IP is whitelisted
function isAdmin() {
    return new Promise((resolve, reject) => {
        fetch('https://api64.ipify.org?format=json')
            .then(response => response.json())
            .then(data => {
                resolve(adminIPs.includes(data.ip));
            })
            .catch(error => {
                console.error('Error fetching IP address:', error);
                reject(false);
            });
    });
}

function updateSelectedMarker() {
    const { selectedMarker } = window.sharedData;
    if (selectedMarker) {
        const label = document.getElementById('marker-label').value;
        const iconUrl = document.getElementById('marker-icon').value;
        selectedMarker.setIcon(new CustomIcon({ iconUrl }));
        selectedMarker.unbindTooltip().bindTooltip(label);
        firebase.database().ref('markers/' + selectedMarker.options.id).set({
            position: selectedMarker.getLatLng(),
            iconUrl,
            label
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

    firebase.database().ref('markers/' + id).set({
        position: { lat: 3277, lng: 4096 },
        iconUrl,
        label
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
        loadUserMarkers();
    }
});

// Check if the user is an admin
isAdmin().then((adminStatus) => {
    window.sharedData = window.sharedData || {};
    window.sharedData.isAdmin = adminStatus;

    if (adminStatus) {
        document.getElementById('admin-toggle').style.display = 'block';
    }
    loadUserMarkers();
});
