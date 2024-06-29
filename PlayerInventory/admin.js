// Firebase Configuration
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

const db = firebase.database();

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('item-form').addEventListener('submit', e => {
        e.preventDefault();

        const itemName = document.getElementById('item-name').value;
        const itemHealth = document.getElementById('item-health').value || 100;
        const itemTooltip = document.getElementById('item-tooltip').value;
        const itemImage = document.getElementById('item-image').files[0];

        if (itemName && itemTooltip && itemImage) {
            const newItemRef = db.ref('items').push();
            const storageRef = firebase.storage().ref();
            const uploadTask = storageRef.child(`images/${newItemRef.key}`).put(itemImage);

            uploadTask.on('state_changed',
                snapshot => {
                    // Handle upload progress
                },
                error => {
                    console.error('Image upload failed:', error);
                },
                () => {
                    uploadTask.snapshot.ref.getDownloadURL().then(downloadURL => {
                        newItemRef.set({
                            name: itemName,
                            health: itemHealth,
                            tooltip: itemTooltip,
                            image: downloadURL
                        });
                    });
                }
            );
        }
    });

    document.getElementById('user-form').addEventListener('submit', e => {
        e.preventDefault();

        const username = document.getElementById('username').value;
        const userPassword = document.getElementById('user-password').value;
        const characterName = document.getElementById('character-name').value;
        const gold = document.getElementById('gold').value;

        if (username && userPassword && characterName && gold) {
            const newUserRef = db.ref('users_new').push();
            newUserRef.set({
                username: username,
                password: userPassword,
                characterName: characterName,
                gold: gold,
                inventory: [],
                log: ""
            })
            .then(() => {
                console.log('New user created:', username);
            })
            .catch(error => {
                console.error('Failed to create user:', error.message);
            });
        }
    });

    // Load Players
    db.ref('users_new').on('value', snapshot => {
        const users = snapshot.val();
        const playerSelect = document.getElementById('player-select');
        playerSelect.innerHTML = '<option value="">Select Player</option>';
        for (const uid in users) {
            const user = users[uid];
            const option = document.createElement('option');
            option.value = uid;
            option.textContent = user.username || uid;
            playerSelect.appendChild(option);
        }
    });

    // Display and Modify Player Inventory
    document.getElementById('player-select').addEventListener('change', e => {
        const uid = e.target.value;
        if (uid) {
            const inventoryRef = db.ref('users_new/' + uid + '/inventory');
            const logRef = db.ref('users_new/' + uid + '/log');

            inventoryRef.on('value', snapshot => {
                const inventory = snapshot.val();
                const weaponsItems = document.getElementById('weapons-items');
                const armorItems = document.getElementById('armor-items');
                const potionsItems = document.getElementById('potions-items');
                const booksItems = document.getElementById('books-items');
                const valuablesItems = document.getElementById('valuables-items');
                weaponsItems.innerHTML = '';
                armorItems.innerHTML = '';
                potionsItems.innerHTML = '';
                booksItems.innerHTML = '';
                valuablesItems.innerHTML = '';

                for (const key in inventory) {
                    const item = inventory[key];
                    const itemCard = document.createElement('div');
                    itemCard.classList.add('item-card');
                    itemCard.innerHTML = `
                        <img src="${item.image}" alt="${item.name}">
                        <p>${item.name}</p>
                    `;
                    itemCard.addEventListener('click', () => {
                        showItemDetails(item);
                    });

                    if (item.class === 'Weapons') {
                        weaponsItems.appendChild(itemCard);
                    } else if (item.class === 'Armor') {
                        armorItems.appendChild(itemCard);
                    } else if (item.class === 'Potions') {
                        potionsItems.appendChild(itemCard);
                    } else if (item.class === 'Books') {
                        booksItems.appendChild(itemCard);
                    } else if (item.class === 'Valuables') {
                        valuablesItems.appendChild(itemCard);
                    }
                }
            });

            logRef.on('value', snapshot => {
                const log = snapshot.val() || '';
                const logTextarea = document.getElementById('log');
                logTextarea.value = log;
            });
        }
    });

    function showItemDetails(item) {
        // Implement the logic to show item details in a larger view
        console.log('Show item details:', item);
    }

    window.removeItem = function(uid, itemId) {
        const itemRef = db.ref('users_new/' + uid + '/inventory/' + itemId);
        itemRef.remove();
        const logRef = db.ref('users_new/' + uid + '/log');
        logRef.transaction(log => (log || '') + `\nRemoved item ${itemId}`);
    };
});
