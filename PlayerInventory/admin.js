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
const auth = firebase.auth();

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('item-form').addEventListener('submit', e => {
        e.preventDefault();

        const itemName = document.getElementById('item-name').value;
        const itemImage = document.getElementById('item-image').value;
        const itemClass = document.getElementById('item-class').value;
        const itemHealth = document.getElementById('item-health').value || 100;

        if (itemName && itemImage && itemClass) {
            const newItemRef = db.ref('items').push();
            newItemRef.set({
                name: itemName,
                image: itemImage,
                class: itemClass,
                health: itemClass === 'Weapons' || itemClass === 'Armor' ? itemHealth : null
            });
        }
    });

    document.getElementById('user-form').addEventListener('submit', e => {
        e.preventDefault();

        const username = document.getElementById('username').value;
        const userPassword = document.getElementById('user-password').value;
        const characterName = document.getElementById('character-name').value;
        const gold = document.getElementById('gold').value;

        if (username && userPassword && characterName && gold) {
            auth.createUserWithEmailAndPassword(`${username}@example.com`, userPassword)
                .then(userCredential => {
                    const userIdRef = db.ref('user_id_counter');
                    userIdRef.transaction(currentId => (currentId || 0) + 1, (error, committed, snapshot) => {
                        if (committed) {
                            const newUserId = snapshot.val();
                            db.ref('users_new/' + userCredential.user.uid).set({
                                username: username,
                                characterName: characterName,
                                userId: newUserId,
                                gold: gold,
                                inventory: [],
                                log: ""
                            })
                            .then(() => {
                                console.log('New user created with ID:', newUserId);
                            })
                            .catch(dbError => {
                                console.error('Failed to add user to users_new table:', dbError.message);
                            });
                        }
                    });
                })
                .catch(error => {
                    console.error(error);
                    alert('User creation failed: ' + error.message);
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
                const adminInventoryDiv = document.getElementById('admin-inventory');
                adminInventoryDiv.innerHTML = '';
                for (const key in inventory) {
                    const item = inventory[key];
                    const itemCard = document.createElement('div');
                    itemCard.classList.add('item-card');
                    itemCard.innerHTML = `
                        <img src="${item.image}" alt="${item.name}">
                        <p>${item.name}</p>
                        ${(item.class === 'Weapons' || item.class === 'Armor') ? createHealthBar(item.health) : ''}
                        <button onclick="removeItem('${uid}', '${key}')">Remove</button>
                    `;
                    if ((item.class === 'Weapons' || item.class === 'Armor') && item.health <= 0) {
                        itemCard.style.borderColor = 'red';
                    }
                    adminInventoryDiv.appendChild(itemCard);
                }
            });

            logRef.on('value', snapshot => {
                const log = snapshot.val() || '';
                const logTextarea = document.getElementById('log');
                logTextarea.value = log;
            });
        }
    });

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

    window.removeItem = function(uid, itemId) {
        const itemRef = db.ref('users_new/' + uid + '/inventory/' + itemId);
        itemRef.remove();
        const logRef = db.ref('users_new/' + uid + '/log');
        logRef.transaction(log => (log || '') + `\nRemoved item ${itemId}`);
    };
});
