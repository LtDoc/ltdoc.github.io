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
                        document.getElementById('inventory-container').style.display = 'block';
                        loadInventory(userKey);
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

    function loadInventory(uid) {
        const userRef = db.ref('users_new/' + uid);
        const inventoryRef = db.ref('users_new/' + uid + '/inventory');
        const logRef = db.ref('users_new/' + uid + '/log');

        userRef.on('value', snapshot => {
            const user = snapshot.val();
            document.getElementById('character-name').textContent = `${user.characterName} | ${uid}`;
            document.getElementById('gold-amount').textContent = user.gold;
            document.getElementById('bank-amount').textContent = user.bank;
        });

        inventoryRef.on('value', snapshot => {
            const inventory = snapshot.val();
            const weaponsItems = document.getElementById('weapons-items');
            const armorItems = document.getElementById('armor-items');
            const potionsItems = document.getElementById('potions-items');
            const booksItems = document.getElementById('books-items');
            const valuablesItems = document.getElementById('valuables-items');
            const miscItems = document.getElementById('misc-items');

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
                    <p>${item.name}</p>
                    <img src="${item.image}" alt="${item.name}" onclick="showItemDetails('${item.image}', '${item.tooltip}')">
                    <div class="health-bar" style="width: ${item.health}%; background-color: ${getHealthColor(item.health, item.startingHealth)};"></div>
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
});

function showItemDetails(image, tooltip) {
    const modal = document.getElementById('item-details-modal');
    const modalImg = document.getElementById('modal-image');
    const modalTooltip = document.getElementById('modal-tooltip');

    modalImg.src = image;
    modalTooltip.textContent = tooltip;
    modal.style.display = 'block';
}

document.querySelector('.close').addEventListener('click', function() {
    document.getElementById('item-details-modal').style.display = 'none';
});
