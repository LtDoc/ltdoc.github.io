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

document.getElementById('login-form').addEventListener('submit', e => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    auth.signInWithEmailAndPassword(`${username}@example.com`, password)
        .then(userCredential => {
            document.getElementById('login-container').style.display = 'none';
            document.getElementById('inventory-container').style.display = 'block';
            loadInventory(userCredential.user.uid);
        })
        .catch(error => {
            console.error(error);
            alert('Login failed: ' + error.message);
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
                ${item.class === 'Weapons' || item.class === 'Armor' ? createHealthBar(item.health) : ''}
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

// Create default admin account
