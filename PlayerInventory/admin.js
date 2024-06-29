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
    // Create Item
    document.getElementById('item-form').addEventListener('submit', e => {
        e.preventDefault();

        const itemName = document.getElementById('item-name').value.trim();
        const itemHealth = parseInt(document.getElementById('item-health').value) || 100;
        const itemTooltip = document.getElementById('item-tooltip').value.trim();
        const itemImage = document.getElementById('item-image').files[0];
        const itemCategory = document.getElementById('item-category').value.trim();

        if (itemName && itemTooltip && itemImage && itemCategory) {
            const newItemRef = db.ref('items').push();
            const storageRef = storage.ref(`images/${newItemRef.key}`);

            const uploadTask = storageRef.put(itemImage);

            uploadTask.on('state_changed',
                snapshot => {
                    // Handle upload progress
                },
                error => {
                    console.error('Image upload failed:', error);
                },
                () => {
                    uploadTask.snapshot.ref.getDownloadURL().then(downloadURL => {
                        const newItem = {
                            name: itemName,
                            health: itemHealth,
                            tooltip: itemTooltip,
                            image: downloadURL,
                            category: itemCategory
                        };

                        newItemRef.set(newItem)
                        .then(() => {
                            console.log('New item created successfully:', newItem);
                            document.getElementById('item-form').reset();
                            loadExistingItems();
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

    // Create User
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
                bank: 0,  // Initialize bank with 0
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
        const currentSelection = playerSelect.value;
        playerSelect.innerHTML = '<option value="">Select Player</option>';
        for (const uid in users) {
            const user = users[uid];
            const option = document.createElement('option');
            option.value = uid;
            option.textContent = user.username || uid;
            playerSelect.appendChild(option);
        }
        playerSelect.value = currentSelection;
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
            document.getElementById('update-gold').value = user.gold;
            document.getElementById('update-bank').value = user.bank;
        });

        inventoryRef.on('value', snapshot => {
            const inventory = snapshot.val();
            weaponsItems.innerHTML = '';
            armorItems.innerHTML = '';
            potionsItems.innerHTML = '';
            booksItems.innerHTML = '';
            valuablesItems.innerHTML = '';
            miscItems.innerHTML = '';
        
            for (const key in inventory) {
                const item = inventory[key];
                const itemCard = document.createElement('div');
                itemCard.classList.add('item-card');
                itemCard.innerHTML = `
                    <img src="${item.image}" alt="${item.name}" onclick="showItemDetails('${item.image}', '${item.tooltip}')">
                    <p>${item.name}</p>
                    <div class="health-bar" style="width: ${item.health}%; background-color: ${getHealthColor(item.health, item.startingHealth)};"></div>
                    <button class="remove-btn" onclick="removeItem('${uid}', '${key}', '${item.name}')">X</button>
                `;
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
                } else {
                    miscItems.appendChild(itemCard);
                }
            }
        });

        logRef.on('value', snapshot => {
            const log = snapshot.val() || '';
            const logTextarea = document.getElementById('log');
            logTextarea.value = log;
        });
    }

    function getHealthColor(health) {
        if (health > 75) {
            return 'green';
        } else if (health > 50) {
            return 'yellow';
        } else if (health > 25) {
            return 'orange';
        } else {
            return 'red';
        }
    }

    function clearPlayerDetails() {
        document.getElementById('selected-character').textContent = 'Select a Player';
        document.getElementById('weapons-items').innerHTML = '';
        document.getElementById('armor-items').innerHTML = '';
        document.getElementById('potions-items').innerHTML = '';
        document.getElementById('books-items').innerHTML = '';
        document.getElementById('valuables-items').innerHTML = '';
        document.getElementById('misc-items').innerHTML = '';
        document.getElementById('log').value = '';
    }

    window.removeItem = function(uid, itemId, itemName) {
        const itemRef = db.ref('users_new/' + uid + '/inventory/' + itemId);
        itemRef.remove();
        const logRef = db.ref('users_new/' + uid + '/log');
        logRef.transaction(log => (log || '') + `\nRemoved item ${itemName}`);
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
        db.ref('items/' + itemId).once('value').then(snapshot => {
            const item = snapshot.val();
            if (item) {
                db.ref('users_new/' + uid + '/inventory/' + itemId).set(item);
                const logRef = db.ref('users_new/' + uid + '/log');
                logRef.transaction(log => (log || '') + `\nAdded item ${item.name} to inventory`);
            } else {
                console.error('Item not found:', itemId);
            }
        });
    };

    function loadExistingItems() {
        db.ref('items').on('value', snapshot => {
            const items = snapshot.val();
            const existingItemsTable = document.getElementById('existing-items');
            const existingItemsSelect = document.getElementById('existing-items-select');
            existingItemsTable.innerHTML = '';
            existingItemsSelect.innerHTML = '<option value="">Select Item</option>';

            for (const key in items) {
                const item = items[key];
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${item.name}</td>
                    <td>${item.health}</td>
                    <td>${item.tooltip}</td>
                    <td>${item.category}</td>
                `;
                existingItemsTable.appendChild(row);

                const option = document.createElement('option');
                option.value = key;
                option.textContent = item.name;
                existingItemsSelect.appendChild(option);
            }
        });
    }

    document.getElementById('add-item-form').addEventListener('submit', e => {
        e.preventDefault();
        const playerSelect = document.getElementById('player-select').value;
        const itemId = document.getElementById('existing-items-select').value;
        if (playerSelect && itemId) {
            addItemToInventory(playerSelect, itemId);
        } else {
            alert('Please select a player and an item.');
        }
    });

    document.getElementById('gold-form').addEventListener('submit', e => {
        e.preventDefault();
        const playerSelect = document.getElementById('player-select').value;
        const newGold = parseInt(document.getElementById('update-gold').value);
        const newBank = parseInt(document.getElementById('update-bank').value);
        if (playerSelect && !isNaN(newGold) && !isNaN(newBank)) {
            const userRef = db.ref('users_new/' + playerSelect);
            userRef.update({
                gold: newGold,
                bank: newBank
            }).then(() => {
                console.log('Gold and bank updated successfully');
            }).catch(error => {
                console.error('Failed to update gold and bank:', error);
            });
        } else {
            alert('Please select a player and enter valid gold and bank values.');
        }
    });

    document.getElementById('search-bar').addEventListener('input', e => {
        const searchTerm = e.target.value.toLowerCase();
        const items = document.querySelectorAll('#existing-items tr');
        items.forEach(item => {
            const name = item.children[0].textContent.toLowerCase();
            const health = item.children[1].textContent.toLowerCase();
            const tooltip = item.children[2].textContent.toLowerCase();
            const category = item.children[3].textContent.toLowerCase();
            if (name.includes(searchTerm) || health.includes(searchTerm) || tooltip.includes(searchTerm) || category.includes(searchTerm)) {
                item.style.display = '';
            } else {
                item.style.display = 'none';
            }
        });
    });

    loadExistingItems();
});
