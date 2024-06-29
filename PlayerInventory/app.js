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
    const allowedAdminIPs = ['24.57.218.92', '98.16.223.9'];

    function checkIPAccess() {
        return fetch('https://api.ipify.org?format=json')
            .then(response => response.json())
            .then(data => {
                if (allowedAdminIPs.includes(data.ip)) {
                    window.location.href = 'admin.html';
                } else {
                    document.getElementById('login-container').style.display = 'block';
                }
            });
    }

    checkIPAccess();

    document.getElementById('login-form').addEventListener('submit', e => {
        e.preventDefault();
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;

        db.ref('users_new').orderByChild('username').equalTo(username).once('value')
            .then(snapshot => {
                const users = snapshot.val();
                if (users) {
                    const userKey = Object.keys(users)[0];
                    const user = users[userKey];
                    if (user.password === password) {
                        document.getElementById('login-container').style.display = 'none';
                        document.getElementById('selection-container').style.display = 'block';
                        loadPlayerData(userKey);
                    } else {
                        alert('Incorrect password');
                    }
                } else {
                    alert('User not found');
                }
            })
            .catch(error => {
                console.error('Error logging in:', error);
            });
    });

    function loadPlayerData(uid) {
        document.getElementById('inventory-button').addEventListener('click', () => {
            document.getElementById('selection-container').style.display = 'none';
            document.getElementById('inventory-container').style.display = 'block';
            loadInventory(uid);
        });

        document.getElementById('shop-button').addEventListener('click', () => {
            document.getElementById('selection-container').style.display = 'none';
            document.getElementById('shop-container').style.display = 'block';
            loadShops(uid);
        });

        document.getElementById('navbar-inventory').addEventListener('click', () => {
            document.getElementById('shop-container').style.display = 'none';
            document.getElementById('inventory-container').style.display = 'block';
            loadInventory(uid);
        });

        document.getElementById('navbar-shop').addEventListener('click', () => {
            document.getElementById('inventory-container').style.display = 'none';
            document.getElementById('shop-container').style.display = 'block';
            loadShops(uid);
        });
    }

    function loadInventory(uid) {
        const userRef = db.ref('users_new/' + uid);
        const inventoryRef = db.ref('users_new/' + uid + '/inventory');
        const logRef = db.ref('users_new/' + uid + '/log');

        userRef.on('value', snapshot => {
            const user = snapshot.val();
            document.getElementById('character-name').textContent = user.characterName;
            document.getElementById('gold-amount').textContent = user.gold;
            document.getElementById('bank-amount').textContent = user.bank || 0;
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
                    <img src="${item.image}" alt="${item.name}">
                    <div class="health-bar" style="width: ${(item.health / item.startingHealth) * 100}%; background-color: ${getHealthColor(item.health)};"></div>
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

    function getHealthColor(health) {
        const percentage = (health / 100) * 100;
        if (percentage <= 25) {
            return 'red';
        } else if (percentage <= 50) {
            return 'orange';
        } else {
            return 'green';
        }
    }

    function loadShops(uid) {
        db.ref('users_new/' + uid + '/shops').on('value', snapshot => {
            const userShops = snapshot.val() || {};
            const shopsContainer = document.getElementById('shops');
            shopsContainer.innerHTML = '';

            const shopKeys = Object.keys(userShops);
            if (shopKeys.length === 0) {
                shopsContainer.innerHTML = '<p>No shops available</p>';
            } else {
                shopKeys.forEach(shopKey => {
                    db.ref('shops/' + shopKey).once('value').then(shopSnapshot => {
                        const shop = shopSnapshot.val();
                        const shopDiv = document.createElement('div');
                        shopDiv.classList.add('shop');
                        shopDiv.innerHTML = `<h3>${shop.name}</h3>`;
                        const itemsDiv = document.createElement('div');
                        itemsDiv.classList.add('shop-items');
                        for (const itemKey in shop.items) {
                            const item = shop.items[itemKey];
                            const itemCard = document.createElement('div');
                            itemCard.classList.add('shop-item-card');
                            itemCard.innerHTML = `
                                <p>${item.name}</p>
                                <img src="${item.image}" alt="${item.name}">
                                <p>Price: ${item.price}</p>
                                <button data-item-id="${itemKey}" data-shop-id="${shopKey}" data-price="${item.price}" data-shop-name="${shop.name}">Buy</button>
                            `;
                            itemsDiv.appendChild(itemCard);
                        }
                        shopDiv.appendChild(itemsDiv);
                        shopsContainer.appendChild(shopDiv);
                    });
                });
            }
        });

        document.getElementById('shops').addEventListener('click', e => {
            if (e.target.tagName === 'BUTTON') {
                const itemId = e.target.getAttribute('data-item-id');
                const shopId = e.target.getAttribute('data-shop-id');
                const price = parseInt(e.target.getAttribute('data-price'));
                const shopName = e.target.getAttribute('data-shop-name');
                purchaseItem(uid, itemId, shopId, price, shopName);
            }
        });
    }

    function purchaseItem(uid, itemId, shopId, price, shopName) {
        const userRef = db.ref('users_new/' + uid);
        userRef.once('value').then(snapshot => {
            const user = snapshot.val();
            if (user.gold >= price) {
                const itemRef = db.ref('shops/' + shopId + '/items/' + itemId);
                itemRef.once('value').then(itemSnapshot => {
                    const item = itemSnapshot.val();
                    if (item) {
                        const userInventoryRef = db.ref('users_new/' + uid + '/inventory/' + itemId);
                        userInventoryRef.set(item);
                        userRef.child('gold').set(user.gold - price);
                        itemRef.remove();
                        const logRef = db.ref('users_new/' + uid + '/log');
                        logRef.transaction(log => (log || '') + `\nPurchased item ${item.name} from ${shopName} for ${price}`);
                        loadShops(uid); // Reload shops to update the available items
                    }
                });
            } else {
                alert('Not enough gold.');
            }
        });
    }
});
