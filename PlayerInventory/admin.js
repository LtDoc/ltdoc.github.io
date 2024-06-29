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

const ITEMS_PER_PAGE = 12;
let currentPage = 1;
let allItems = [];
let displayedItems = [];

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
            const sections = {
                'Weapons': document.getElementById('weapons-items'),
                'Armor': document.getElementById('armor-items'),
                'Potions': document.getElementById('potions-items'),
                'Books': document.getElementById('books-items'),
                'Valuables': document.getElementById('valuables-items'),
                'Misc': document.getElementById('misc-items')
            };

            for (const section in sections) {
                sections[section].innerHTML = '';
            }

            for (const key in inventory) {
                const item = inventory[key];
                const itemCard = document.createElement('div');
                itemCard.classList.add('item-card');
                itemCard.innerHTML = `
                    <p>${item.name}</p>
                    <img src="${item.image}" alt="${item.name}" onclick="showItemDetails('${item.image}', '${item.tooltip}')">
                    <div class="health-bar" style="width: ${item.health}%; background-color: ${getHealthColor(item.health, item.startingHealth)};"></div>
                    <button class="remove-btn" onclick="removeItem('${uid}', '${key}', '${item.name}')">X</button>
                `;
                sections[item.category].appendChild(itemCard);
            }
        });

        logRef.on('value', snapshot => {
            const log = snapshot.val() || '';
            const logTextarea = document.getElementById('log');
            logTextarea.value = log;
        });
    }

    function getHealthColor(currentHealth, startingHealth) {
        const healthPercentage = (currentHealth / startingHealth) * 100;
        if (healthPercentage > 75) {
            return 'green';
        } else if (healthPercentage > 50) {
            return 'yellow';
        } else if (healthPercentage > 25) {
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
                const userInventoryRef = db.ref('users_new/' + uid + '/inventory').push();
                userInventoryRef.set(item);
                const logRef = db.ref('users_new/' + uid + '/log');
                logRef.transaction(log => (log || '') + `\nAdded item ${item.name} to inventory`);
            } else {
                console.error('Item not found:', itemId);
            }
        });
    };

    function loadExistingItems() {
        db.ref('items').on('value', snapshot => {
            allItems = Object.entries(snapshot.val() || {}).map(([key, value]) => ({ id: key, ...value }));
            displayedItems = allItems;
            displayItems();
            displayPagination();
        });
    }

    function displayItems() {
        const existingItemsTable = document.getElementById('existing-items');
        const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
        const endIndex = startIndex + ITEMS_PER_PAGE;
        const itemsToDisplay = displayedItems.slice(startIndex, endIndex);
        
        existingItemsTable.innerHTML = '';
        itemsToDisplay.forEach(item => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><input type="checkbox" class="checkbox" value="${item.id}"></td>
                <td>${item.name}</td>
                <td>${item.health}</td>
                <td>${item.tooltip}</td>
                <td>${item.category}</td>
            `;
            existingItemsTable.appendChild(row);
        });
    }

    function displayPagination() {
        const pagination = document.getElementById('pagination');
        const pageCount = Math.ceil(displayedItems.length / ITEMS_PER_PAGE);
        
        pagination.innerHTML = '';
        for (let i = 1; i <= pageCount; i++) {
            const button = document.createElement('button');
            button.textContent = i;
            button.disabled = i === currentPage;
            button.addEventListener('click', () => {
                currentPage = i;
                displayItems();
            });
            pagination.appendChild(button);
        }
    }

    document.getElementById('add-items-btn').addEventListener('click', () => {
        const playerSelect = document.getElementById('player-select').value;
        const selectedItems = document.querySelectorAll('.checkbox:checked');
        if (playerSelect && selectedItems.length > 0) {
            selectedItems.forEach(item => {
                addItemToInventory(playerSelect, item.value);
            });
        } else {
            alert('Please select a player and at least one item.');
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
                const logRef = db.ref('users_new/' + playerSelect + '/log');
                logRef.transaction(log => (log || '') + `\nUpdated gold to ${newGold} and bank to ${newBank}`);
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
        if (searchTerm) {
            displayedItems = allItems.filter(item => 
                item.name.toLowerCase().includes(searchTerm) ||
                item.health.toString().toLowerCase().includes(searchTerm) ||
                item.tooltip.toLowerCase().includes(searchTerm) ||
                item.category.toLowerCase().includes(searchTerm)
            );
        } else {
            displayedItems = allItems; // Reset to all items if search term is empty
        }
        currentPage = 1;
        displayItems();
        displayPagination();
    });

    loadExistingItems();
});

function showItemDetails(image, tooltip) {
    const modal = document.createElement('div');
    modal.classList.add('modal');
    modal.innerHTML = `
        <div class="modal-content">
            <span class="close" onclick="this.parentElement.parentElement.style.display='none';">&times;</span>
            <img src="${image}" alt="Item Image" style="width: 300px; height: 300px; object-fit: contain;">
            <p>${tooltip}</p>
        </div>
    `;
    document.body.appendChild(modal);
    modal.style.display = 'block';
}
