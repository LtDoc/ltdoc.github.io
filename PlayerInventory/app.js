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
                    document.getElementById('admin-button').style.display = 'block';
                    document.getElementById('admin-button').addEventListener('click', () => {
                        window.location.href = 'admin.html';
                    });
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
            document.getElementById('character-name').textContent = user.characterName;
            document.getElementById('gold-amount').textContent = user.gold;
        });

        inventoryRef.on('value', snapshot => {
            const inventory = snapshot.val();
            const inventoryDiv = document.getElementById('inventory');
            inventoryDiv.innerHTML = '';
            for (const key in inventory) {
                const item = inventory[key];
                const itemCard = document.createElement('div');
                itemCard.classList.add('item-card');
                itemCard.innerHTML = `
                    <img src="${item.image}" alt="${item.name}">
                    <p>${item.name}</p>
                    ${(item.class === 'Weapons' || item.class === 'Armor') ? createHealthBar(item.health) : ''}
                `;
                if ((item.class === 'Weapons' || item.class === 'Armor') && item.health <= 0) {
                    itemCard.style.borderColor = 'red';
                }
                inventoryDiv.appendChild(itemCard);
            }
        });

        logRef.on('value', snapshot => {
            const log = snapshot.val() || '';
            const logTextarea = document.getElementById('log');
            logTextarea.value = log;
        });
    }

    function createHealthBar(health) {
        const healthPercentage = (health / 100) * 100;
        let color = 'green';
        if (healthPercentage <= 25) {
            color = 'orange';
        }
        if (healthPercentage <= 0) {
            color = 'red';
        } else if (healthPercentage <= 50) {
            color = 'yellow';
        }
        return `<div class="health-bar" style="width: ${healthPercentage}%; background-color: ${color};"></div>`;
    }
});
