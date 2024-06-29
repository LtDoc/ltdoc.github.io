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
const storage = firebase.storage();

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('item-form').addEventListener('submit', e => {
        e.preventDefault();

        // Get form values
        const itemName = document.getElementById('item-name').value.trim();
        const itemHealth = parseInt(document.getElementById('item-health').value) || 100;
        const itemTooltip = document.getElementById('item-tooltip').value.trim();
        const itemImage = document.getElementById('item-image').files[0];
        const itemCategory = document.getElementById('item-category').value.trim();

        // Validate form inputs
        if (itemName && itemTooltip && itemImage && itemCategory) {
            const newItemRef = db.ref('items').push();
            const storageRef = storage.ref(`images/${newItemRef.key}`);

            const uploadTask = storageRef.put(itemImage);

            uploadTask.on('state_changed',
                snapshot => {
                    // Optional: Handle upload progress
                },
                error => {
                    console.error('Image upload failed:', error);
                },
                () => {
                    uploadTask.snapshot.ref.getDownloadURL().then(downloadURL => {
                        // Create item object
                        const newItem = {
                            name: itemName,
                            health: itemHealth,
                            tooltip: itemTooltip,
                            image: downloadURL,
                            category: itemCategory
                        };

                        // Store item data in Firebase Realtime Database
                        newItemRef.set(newItem)
                        .then(() => {
                            console.log('New item created successfully:', newItem);
                            // Optional: Reset the form
                            document.getElementById('item-form').reset();
                        })
                        .catch(error => {
                            console.error('Failed to create new item:', error);
                        });
                    });
                }
            );
        } else {
            alert('Please fill in all required fields and upload an image.');
        }
    });

    document.getElementById('user-form').addEventListener('submit', e => {
        e.preventDefault();

        const username = document.getElementById('username').value.trim();
        const userPassword = document.getElementById('user-password').value.trim();
        const characterName = document.getElementById('character-name').value.trim();
        const gold = parseInt(document.getElementById('gold').value);

        if (username && userPassword && characterName && !isNaN(gold)) {
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
        } else {
            alert('Please fill in all fields.');
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
            displayPlayerDetails(uid);
        } else {
            clearPlayerDetails();
        }
    });

    function displayPlayerDetails(uid) {
        const userRef = db.ref('users_new/' + uid);
        const inventoryRef = db.ref('users_new/' + uid + '/inventory');
        const logRef = db.ref('users_new/' + uid + '/log');

        userRef.once('value').then(snapshot => {
            const user = snapshot.val();
            document.getElementById('selected-character').textContent = `${user.characterName} | ${uid}`;
        });

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
                    <button onclick="modifyItemHealth('${uid}', '${key}', ${item.health})">Modify Health</button>
                    <button onclick="removeItem('${uid}', '${key}')">Remove Item</button>
                `;
                itemCard.addEventListener('click', () => {
                    showItemDetails(item);
                });

                if (item.category === 'Weapons') {
                    weaponsItems.appendChild(itemCard);
                } else if (item.category === 'Armor') {
                    armorItems.appendChild(itemCard);
                } else if (item.category === 'Potions') {
                    potionsItems.appendChild(itemCard);
                } else if (item.category === 'Books') {
                    booksItems.appendChild(itemCard);
                } else if (item.category === 'Valuables') {
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

    function clearPlayerDetails() {
        document.getElementById('selected-character').textContent = 'Select a Player';
        document.getElementById('weapons-items').innerHTML = '';
        document.getElementById('armor-items').innerHTML = '';
        document.getElementById('potions-items').innerHTML = '';
        document.getElementById('books-items').innerHTML = '';
        document.getElementById('valuables-items').innerHTML = '';
        document.getElementById('log').value = '';
    }

    window.removeItem = function(uid, itemId) {
        const itemRef = db.ref('users_new/' + uid + '/inventory/' + itemId);
        itemRef.remove();
        const logRef = db.ref('users_new/' + uid + '/log');
        logRef.transaction(log => (log || '') + `\nRemoved item ${itemId}`);
    };

    window.modifyItemHealth = function(uid, itemId, currentHealth) {
        const newHealth = prompt('Enter new health value:', currentHealth);
        if (newHealth !== null) {
            const itemRef = db.ref('users_new/' + uid + '/inventory/' + itemId + '/health');
            itemRef.set(parseInt(newHealth));
            const logRef = db.ref('users_new/' + uid + '/log');
            logRef.transaction(log => (log || '') + `\nModified health of item ${itemId} to ${newHealth}`);
        }
    };

    window.addItemToInventory = function(uid, itemId) {
        // Get the item details from the items collection
        db.ref('items/' + itemId).once('value').then(snapshot => {
            const item = snapshot.val();
            if (item) {
                // Add the item to the player's inventory
                db.ref('users_new/' + uid + '/inventory/' + itemId).set(item);
                const logRef = db.ref('users_new/' + uid + '/log');
                logRef.transaction(log => (log || '') + `\nAdded item ${itemId} to inventory`);
            } else {
                console.error('Item not found:', itemId);
            }
        });
    };

    // Optional: Function to add an item to a player's inventory via UI
    document.getElementById('add-item-form').addEventListener('submit', e => {
        e.preventDefault();
        const playerSelect = document.getElementById('player-select').value;
        const itemId = document.getElementById('add-item-id').value.trim();
        if (playerSelect && itemId) {
            addItemToInventory(playerSelect, itemId);
        } else {
            alert('Please select a player and enter an item ID.');
        }
    });
});
