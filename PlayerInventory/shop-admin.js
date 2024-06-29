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

const ITEMS_PER_PAGE = 12;
let currentPage = 1;
let allItems = [];
let displayedItems = [];

document.addEventListener('DOMContentLoaded', function() {
    // Create Shop
    document.getElementById('shop-form').addEventListener('submit', e => {
        e.preventDefault();

        const shopName = document.getElementById('shop-name').value.trim();
        if (shopName) {
            const newShopRef = db.ref('shops').push();
            newShopRef.set({
                name: shopName,
                items: {}
            })
            .then(() => {
                console.log('New shop created:', shopName);
                document.getElementById('shop-form').reset();
                loadShops();
            })
            .catch(error => {
                console.error('Failed to create shop:', error);
            });
        } else {
            alert('Please enter a shop name.');
        }
    });

    // Load Shops
    function loadShops() {
        db.ref('shops').on('value', snapshot => {
            const shops = snapshot.val() || {};
            const shopSelect = document.getElementById('shop-select');
            shopSelect.innerHTML = '<option value="">Select Shop</option>';
            for (const shopKey in shops) {
                const shop = shops[shopKey];
                const option = document.createElement('option');
                option.value = shopKey;
                option.textContent = shop.name;
                shopSelect.appendChild(option);
            }
        });
    }

    loadShops();

    // Load Players
    function loadPlayers() {
        db.ref('users_new').on('value', snapshot => {
            const users = snapshot.val() || {};
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
    }

    loadPlayers();

    // Add Player to Shop
    document.getElementById('add-player-btn').addEventListener('click', () => {
        const playerSelect = document.getElementById('player-select').value;
        const shopSelect = document.getElementById('shop-select').value;
        if (playerSelect && shopSelect) {
            const playerShopsRef = db.ref('users_new/' + playerSelect + '/shops');
            playerShopsRef.child(shopSelect).set({
                name: document.querySelector(`#shop-select option[value="${shopSelect}"]`).textContent
            })
            .then(() => {
                console.log('Player added to shop');
            })
            .catch(error => {
                console.error('Failed to add player to shop:', error);
            });
        } else {
            alert('Please select both a player and a shop.');
        }
    });

    // Load Existing Items
    function loadExistingItems() {
        db.ref('items').on('value', snapshot => {
            allItems = Object.entries(snapshot.val() || {}).map(([key, value]) => ({ id: key, ...value }));
            displayedItems = allItems;
            displayItems();
            displayPagination();
        });
    }

    loadExistingItems();

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
                <td><input type="number" placeholder="Price" class="item-price" data-item-id="${item.id}"></td>
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
        const shopSelect = document.getElementById('shop-select').value;
        const selectedItems = document.querySelectorAll('.checkbox:checked');
        if (shopSelect && selectedItems.length > 0) {
            selectedItems.forEach(item => {
                const itemId = item.value;
                const priceInput = document.querySelector(`.item-price[data-item-id="${itemId}"]`);
                const price = parseInt(priceInput.value);
                if (!isNaN(price) && price > 0) {
                    db.ref('shops/' + shopSelect + '/items/' + itemId).set({
                        ...allItems.find(i => i.id === itemId),
                        price: price
                    });
                } else {
                    alert('Please enter a valid price for all selected items.');
                }
            });
        } else {
            alert('Please select a shop and at least one item.');
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
});
