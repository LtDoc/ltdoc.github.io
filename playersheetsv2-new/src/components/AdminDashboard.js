// src/components/AdminDashboard.js

import React, { useState, useEffect } from 'react';
import { Box, Typography, TextField, Button, Select, MenuItem, FormControl, InputLabel, Grid, Divider, AppBar, Toolbar, IconButton } from '@mui/material';
import { database } from '../firebase';
import { ref, get, set, child } from 'firebase/database';
import { useNavigate } from 'react-router-dom';
import MenuIcon from '@mui/icons-material/Menu';

const AdminDashboard = () => {
  const [users, setUsers] = useState([]);
  const [skills, setSkills] = useState([]);
  const [senses, setSenses] = useState([]);
  const [languages, setLanguages] = useState([]);
  const [damageResistance, setDamageResistance] = useState([]);
  const [magicResistance, setMagicResistance] = useState([]);
  const [spellcasting, setSpellcasting] = useState([]);
  const [abilities, setAbilities] = useState([]);
  const [actions, setActions] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [items, setItems] = useState([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [selectedCharacter, setSelectedCharacter] = useState(null);
  const [newCharacter, setNewCharacter] = useState({
    name: '',
    class: '',
    race: '',
    hp: '',
    ac: '',
    stats: {
      str: 10,
      dex: 10,
      int: 10,
      cha: 10,
      sta: 10,
      con: 10,
      per: 10,
    },
    skills: [],
    senses: [],
    languages: [],
    damageResistance: [],
    magicResistance: [],
    spellcasting: [],
    abilities: [],
    actions: [],
    reactions: [],
    items: [],
  });

  const navigate = useNavigate();

  useEffect(() => {
    const fetchData = async () => {
      const dbRef = ref(database);
      const snapshot = await get(child(dbRef, `lists`));

      if (snapshot.exists()) {
        const lists = snapshot.val();
        setSkills(lists.skills || []);
        setSenses(lists.senses || []);
        setLanguages(lists.languages || []);
        setDamageResistance(lists.damageResistance || []);
        setMagicResistance(lists.magicResistance || []);
        setSpellcasting(lists.spellcasting || []);
        setAbilities(lists.abilities || []);
        setActions(lists.actions || []);
        setReactions(lists.reactions || []);
        setItems(lists.items || []);
      }

      const usersSnapshot = await get(child(dbRef, `users`));
      if (usersSnapshot.exists()) {
        const usersData = usersSnapshot.val();
        const userList = Object.keys(usersData).map(key => ({ id: key, ...usersData[key] }));
        setUsers(userList);
      }
    };

    fetchData();
  }, []);

  const handleUserChange = (event) => {
    const userId = event.target.value;
    setSelectedUser(userId);
    const user = users.find(user => user.id === userId);
    if (user && user.characters) {
      const firstCharacterId = Object.keys(user.characters)[0];
      setSelectedCharacter(user.characters[firstCharacterId]);
    }
  };

  const handleCharacterChange = (event) => {
    const characterId = event.target.value;
    const user = users.find(user => user.id === selectedUser);
    setSelectedCharacter(user.characters[characterId]);
  };

  const handleChange = (event) => {
    const { name, value } = event.target;
    setSelectedCharacter(prev => ({ ...prev, [name]: value }));
  };

  const handleStatChange = (event) => {
    const { name, value } = event.target;
    setSelectedCharacter(prev => ({
      ...prev,
      stats: { ...prev.stats, [name]: value }
    }));
  };

  const handleNewCharacterChange = (event) => {
    const { name, value } = event.target;
    setNewCharacter(prev => ({ ...prev, [name]: value }));
  };

  const handleListChange = (field) => (event) => {
    const value = event.target.value;
    setSelectedCharacter(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async () => {
    if (!selectedUser || !selectedCharacter) return;

    await set(ref(database, `users/${selectedUser}/characters/${selectedCharacter.id}`), selectedCharacter);
    alert('Character updated successfully');
  };

  const addNewCharacter = async () => {
    if (!selectedUser || !newCharacter.name) return;

    const characterId = `char${Date.now()}`;
    await set(ref(database, `users/${selectedUser}/characters/${characterId}`), {
      ...newCharacter,
      id: characterId,
    });

    setNewCharacter({
      name: '',
      class: '',
      race: '',
      hp: '',
      ac: '',
      stats: {
        str: 10,
        dex: 10,
        int: 10,
        cha: 10,
        sta: 10,
        con: 10,
        per: 10,
      },
      skills: [],
      senses: [],
      languages: [],
      damageResistance: [],
      magicResistance: [],
      spellcasting: [],
      abilities: [],
      actions: [],
      reactions: [],
      items: [],
    });

    alert('New character added successfully');
  };

  const renderMultiSelect = (label, field, items) => (
    <FormControl fullWidth margin="normal">
      <InputLabel>{label}</InputLabel>
      <Select
        multiple
        value={selectedCharacter[field] || []}
        onChange={handleListChange(field)}
        renderValue={(selected) => selected.join(', ')}
      >
        {items.map((item) => (
          <MenuItem key={item.name} value={item.name}>
            {item.name}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );

  return (
    <Box>
      <AppBar position="static">
        <Toolbar>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="menu"
            sx={{ mr: 2 }}
            onClick={() => navigate('/list-management')}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6">
            Admin Dashboard
          </Typography>
        </Toolbar>
      </AppBar>
      <Typography variant="h4" gutterBottom>Admin Dashboard</Typography>
      <FormControl fullWidth margin="normal">
        <InputLabel>User</InputLabel>
        <Select value={selectedUser} onChange={handleUserChange}>
          {users.map((user) => (
            <MenuItem key={user.id} value={user.id}>{user.username}</MenuItem>
          ))}
        </Select>
      </FormControl>
      {selectedUser && (
        <>
          <FormControl fullWidth margin="normal">
            <InputLabel>Character</InputLabel>
            <Select value={selectedCharacter?.id || ''} onChange={handleCharacterChange}>
              {users.find(user => user.id === selectedUser)?.characters && Object.entries(users.find(user => user.id === selectedUser).characters).map(([id, character]) => (
                <MenuItem key={id} value={id}>{character.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
          {selectedCharacter && (
            <>
              <TextField
                label="Name"
                name="name"
                value={selectedCharacter.name}
                onChange={handleChange}
                fullWidth
                margin="normal"
              />
              <TextField
                label="Class"
                name="class"
                value={selectedCharacter.class}
                onChange={handleChange}
                fullWidth
                margin="normal"
              />
              <TextField
                label="Race"
                name="race"
                value={selectedCharacter.race}
                onChange={handleChange}
                fullWidth
                margin="normal"
              />
              <TextField
                label="HP"
                name="hp"
                value={selectedCharacter.hp}
                onChange={handleChange}
                fullWidth
                margin="normal"
              />
              <TextField
                label="AC"
                name="ac"
                value={selectedCharacter.ac}
                onChange={handleChange}
                fullWidth
                margin="normal"
              />
              <Typography variant="h6">Stats</Typography>
              <Grid container spacing={2}>
                {Object.entries(selectedCharacter.stats).map(([stat, value]) => (
                  <Grid item xs={4} key={stat}>
                    <TextField
                      label={stat.toUpperCase()}
                      name={stat}
                      type="number"
                      value={value}
                      onChange={handleStatChange}
                      fullWidth
                    />
                  </Grid>
                ))}
              </Grid>
              <Divider sx={{ my: 2 }} />
              {renderMultiSelect('Skills', 'skills', skills)}
              {renderMultiSelect('Senses', 'senses', senses)}
              {renderMultiSelect('Languages', 'languages', languages)}
              {renderMultiSelect('Damage Resistance', 'damageResistance', damageResistance)}
              {renderMultiSelect('Magic Resistance', 'magicResistance', magicResistance)}
              {renderMultiSelect('Spellcasting', 'spellcasting', spellcasting)}
              {renderMultiSelect('Abilities', 'abilities', abilities)}
              {renderMultiSelect('Actions', 'actions', actions)}
              {renderMultiSelect('Reactions', 'reactions', reactions)}
              {renderMultiSelect('Items', 'items', items)}
              <Button variant="contained" color="primary" onClick={handleSubmit} sx={{ mt: 2 }}>
                Save Changes
              </Button>
              <Divider sx={{ my: 4 }} />
            </>
          )}
        </>
      )}
      <Typography variant="h5" gutterBottom>Add New Character</Typography>
      <TextField
        label="Name"
        name="name"
        value={newCharacter.name}
        onChange={handleNewCharacterChange}
        fullWidth
        margin="normal"
      />
      <TextField
        label="Class"
        name="class"
        value={newCharacter.class}
        onChange={handleNewCharacterChange}
        fullWidth
        margin="normal"
      />
      <TextField
        label="Race"
        name="race"
        value={newCharacter.race}
        onChange={handleNewCharacterChange}
        fullWidth
        margin="normal"
      />
      <TextField
        label="HP"
        name="hp"
        value={newCharacter.hp}
        onChange={handleNewCharacterChange}
        fullWidth
        margin="normal"
      />
      <TextField
        label="AC"
        name="ac"
        value={newCharacter.ac}
        onChange={handleNewCharacterChange}
        fullWidth
        margin="normal"
      />
      <Typography variant="h6">Stats</Typography>
      <Grid container spacing={2}>
        {Object.entries(newCharacter.stats).map(([stat, value]) => (
          <Grid item xs={4} key={stat}>
            <TextField
              label={stat.toUpperCase()}
              name={stat}
              type="number"
              value={value}
              onChange={handleNewCharacterChange}
              fullWidth
            />
          </Grid>
        ))}
      </Grid>
      <Button variant="contained" color="primary" onClick={addNewCharacter} sx={{ mt: 2 }}>
        Add Character
      </Button>
    </Box>
  );
};

export default AdminDashboard;
