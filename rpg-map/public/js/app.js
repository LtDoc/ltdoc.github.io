const config = {
    type: Phaser.AUTO,
    width: window.innerWidth,
    height: window.innerHeight,
    scene: {
        preload: preload,
        create: create,
        update: update
    }
};

const game = new Phaser.Game(config);

let players = [];
let enemies = [];
let npcs = [];
let currentMap;
let selectedUnit;
let isAdmin = false;

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

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const storage = firebase.storage();

function preload() {
    // Preload default images from assets folder
    this.load.image('defaultMap', 'assets/defaultMap.png');
    this.load.image('player', 'assets/player.png');
    this.load.image('enemy', 'assets/enemy.png');
    this.load.image('npc', 'assets/npc.png');
}

function create() {
    // Load the current map from Firebase
    loadMap(this);

    createGrid(this);
    setupFirebaseListeners();

    fetch('https://api.ipify.org?format=json')
        .then(response => response.json())
        .then(data => {
            if (adminIPs.includes(data.ip)) {
                isAdmin = true;
                showAdminOptions();
            }
        });

    this.input.on('gameobjectdown', function (pointer, gameObject) {
        showTooltip(gameObject);
    });
}

function update() {
    updateHPBars(players);
    updateHPBars(enemies);
    updateHPBars(npcs);
}

function createGrid(scene) {
    const gridSize = 50;
    for (let x = 0; x < config.width; x += gridSize) {
        for (let y = 0; y < config.height; y += gridSize) {
            scene.add.line(0, 0, x, 0, x, config.height, 0x00ff00).setOrigin(0, 0);
            scene.add.line(0, 0, 0, y, config.width, y, 0x00ff00).setOrigin(0, 0);
        }
    }
}

function setupFirebaseListeners() {
    db.ref('players').on('child_added', snapshot => {
        const playerData = snapshot.val();
        addPlayer(playerData.x, playerData.y, playerData);
    });

    db.ref('enemies').on('child_added', snapshot => {
        const enemyData = snapshot.val();
        addEnemy(enemyData.x, enemyData.y, enemyData);
    });

    db.ref('npcs').on('child_added', snapshot => {
        const npcData = snapshot.val();
        addNPC(npcData.x, npcData.y, npcData);
    });

    db.ref('map').on('value', snapshot => {
        const mapData = snapshot.val();
        if (mapData) {
            loadImage(mapData.url);
        } else {
            loadDefaultMap();
        }
    });
}

function addPlayer(x, y, data) {
    let player = game.scene.scenes[0].add.sprite(x, y, 'player').setInteractive();
    Object.assign(player, data);
    players.push(player);
    addHPBar(player);
}

function addEnemy(x, y, data) {
    let enemy = game.scene.scenes[0].add.sprite(x, y, 'enemy').setInteractive();
    Object.assign(enemy, data);
    enemies.push(enemy);
    addHPBar(enemy);
}

function addNPC(x, y, data) {
    let npc = game.scene.scenes[0].add.sprite(x, y, 'npc').setInteractive();
    Object.assign(npc, data);
    npcs.push(npc);
    addHPBar(npc);
}

function addHPBar(entity) {
    entity.hpBar = game.scene.scenes[0].add.graphics();
    entity.hpBar.fillStyle(0xff0000, 1);
    entity.hpBar.fillRect(entity.x - 50, entity.y - 70, entity.hp, 10);

    entity.on('hpChanged', function () {
        entity.hpBar.clear();
        entity.hpBar.fillStyle(0xff0000, 1);
        entity.hpBar.fillRect(entity.x - 50, entity.y - 70, entity.hp, 10);
    });

    entity.on('pointerdown', function (pointer) {
        showTooltip(entity);
    });
}

function updateHPBars(entities) {
    entities.forEach(entity => {
        entity.hpBar.x = entity.x - 50;
        entity.hpBar.y = entity.y - 70;
    });
}

function showCreateUnitForm() {
    document.getElementById('unit-form').style.display = 'block';
}

function createUnit() {
    const name = document.getElementById('unit-name').value;
    const type = document.getElementById('unit-type').value;
    const hp = parseInt(document.getElementById('unit-hp').value, 10);
    const str = parseInt(document.getElementById('unit-str').value, 10);
    const dex = parseInt(document.getElementById('unit-dex').value, 10);
    const int = parseInt(document.getElementById('unit-int').value, 10);
    const cha = parseInt(document.getElementById('unit-cha').value, 10);
    const sta = parseInt(document.getElementById('unit-sta').value, 10);
    const con = parseInt(document.getElementById('unit-con').value, 10);
    const per = parseInt(document.getElementById('unit-per').value, 10);
    const details = document.getElementById('unit-details').value;

    const unitData = { name, hp, str, dex, int, cha, sta, con, per, details };

    if (type === 'player') {
        saveData('players', unitData);
    } else if (type === 'enemy') {
        saveData('enemies', unitData);
    } else if (type === 'npc') {
        saveData('npcs', unitData);
    }

    document.getElementById('unit-form').style.display = 'none';
}

function showTooltip(entity) {
    selectedUnit = entity;
    document.getElementById('tooltip-name').innerText = entity.name;
    document.getElementById('tooltip-stats').innerText = `
        STR: ${entity.str} DEX: ${entity.dex} INT: ${entity.int}
        CHA: ${entity.cha} STA: ${entity.sta} CON: ${entity.con}
        PER: ${entity.per}
    `;
    document.getElementById('tooltip-details').value = entity.details;

    const tooltip = document.getElementById('tooltip');
    tooltip.style.display = 'block';
    tooltip.style.left = entity.x + 'px';
    tooltip.style.top = entity.y + 'px';

    if (isAdmin) {
        document.getElementById('admin-options').style.display = 'block';
    } else {
        document.getElementById('admin-options').style.display = 'none';
    }
}

function deleteUnit() {
    // Remove unit from Firebase and game
    if (selectedUnit.type === 'player') {
        removeData('players', selectedUnit.id);
    } else if (selectedUnit.type === 'enemy') {
        removeData('enemies', selectedUnit.id);
    } else if (selectedUnit.type === 'npc') {
        removeData('npcs', selectedUnit.id);
    }
    selectedUnit.destroy();
    selectedUnit.hpBar.destroy();
    document.getElementById('tooltip').style.display = 'none';
}

function reduceHP() {
    selectedUnit.hp -= 10;
    selectedUnit.emit('hpChanged');
}

function saveData(path, data) {
    const newData = db.ref(path).push();
    data.id = newData.key;
    newData.set(data);
}

function removeData(path, id) {
    db.ref(`${path}/${id}`).remove();
}

function loadMap(scene) {
    db.ref('map').once('value').then(snapshot => {
        const mapData = snapshot.val();
        if (mapData) {
            loadImage(mapData.url, scene);
        } else {
            loadDefaultMap(scene);
        }
    });
}

function loadDefaultMap(scene) {
    if (currentMap) {
        currentMap.destroy();
    }
    currentMap = scene.add.image(scene.cameras.main.centerX, scene.cameras.main.centerY, 'defaultMap').setOrigin(0.5);
}

function loadImage(url, scene) {
    storage.refFromURL(url).getDownloadURL().then((url) => {
        scene.load.image('customMap', url);
        scene.load.once('complete', () => {
            if (currentMap) {
                currentMap.destroy();
            }
            currentMap = scene.add.image(scene.cameras.main.centerX, scene.cameras.main.centerY, 'customMap').setOrigin(0.5);
        });
        scene.load.start();
    });
}

function uploadMap() {
    const file = document.getElementById('map-upload').files[0];
    if (!file) return;

    const wipeUnits = document.querySelector('input[name="wipe-units"]:checked').value === 'wipe';

    const storageRef = storage.ref('maps/' + file.name);
    storageRef.put(file).then(() => {
        storageRef.getDownloadURL().then(url => {
            db.ref('map').set({ url });

            if (wipeUnits) {
                db.ref('players').remove();
                db.ref('enemies').remove();
                db.ref('npcs').remove();
                players.forEach(player => player.destroy());
                enemies.forEach(enemy => enemy.destroy());
                npcs.forEach(npc => npc.destroy());
                players = [];
                enemies = [];
                npcs = [];
            }
        });
    });
}

function rollDice(sides) {
    const result = Math.floor(Math.random() * sides) + 1;
    alert(`You rolled a ${result}`);
}

const adminIPs = ['YOUR_ADMIN_IP'];
fetch('https://api.ipify.org?format=json')
    .then(response => response.json())
    .then(data => {
        if (adminIPs.includes(data.ip)) {
            isAdmin = true;
        }
    });

function showAdminOptions() {
    // Additional code to show admin options if needed
}
