// src/components/CharacterForm.js

import React, { useState, useEffect } from 'react';
import { getDatabase, ref, child, get, push, update } from 'firebase/database';
import { Box, TextField, Button, MenuItem, Select, FormControl, InputLabel, Typography } from '@mui/material';

const CharacterForm = ({ addCharacter }) => {
  const [character, setCharacter] = useState({ name: '', class: '', race: '', hp: '', ac: '', stats: {}, avatar: '' });
  const [lists, setLists] = useState({
    skills: [],
    senses: [],
    languages: [],
    damageResistance: [],
    magicResistance: [],
    spellcasting: [],
    abilities: [],
    actions: [],
    reactions: [],
  });

  const [selectedItems, setSelectedItems] = useState({
    skills: [],
    senses: [],
    languages: [],
    damageResistance: [],
    magicResistance: [],
    spellcasting: [],
    abilities: [],
    actions: [],
    reactions: [],
  });

  useEffect(() => {
    const fetchLists = async () => {
      const dbRef = ref(getDatabase());
      const listTypes = ['skills', 'senses', 'languages', 'damageResistance', 'magicResistance', 'spellcasting', 'abilities', 'actions', 'reactions'];
      const promises = listTypes.map(type => get(child(dbRef, type)));
      const results = await Promise.all(promises);
      const fetchedLists = results.reduce((acc, snapshot, index) => {
        const type = listTypes[index];
        if (snapshot.exists()) {
          acc[type] = Object.entries(snapshot.val()).map(([id, item]) => ({ id, ...item }));
        } else {
          acc[type] = [];
        }
        return acc;
      }, {});
      setLists(fetchedLists);
    };

    fetchLists();
  }, []);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setCharacter((prevState) => ({ ...prevState, [name]: value }));
  };

  const handleStatChange = (event) => {
    const { name, value } = event.target;
    setCharacter((prevState) => ({ ...prevState, stats: { ...prevState.stats, [name]: value } }));
  };

  const handleSelectChange = (event, type) => {
    const { value } = event.target;
    setSelectedItems((prevState) => ({ ...prevState, [type]: value }));
  };

  const handleSubmit = async () => {
    const dbRef = ref(getDatabase());
    const newCharacterRef = push(child(dbRef, 'characters'));
    await update(newCharacterRef, {
      ...character,
      skills: selectedItems.skills,
      senses: selectedItems.senses,
      languages: selectedItems.languages,
      damageResistance: selectedItems.damageResistance,
      magicResistance: selectedItems.magicResistance,
      spellcasting: selectedItems.spellcasting,
      abilities: selectedItems.abilities,
      actions: selectedItems.actions,
      reactions: selectedItems.reactions,
    });
    addCharacter({ id: newCharacterRef.key, ...character });
  };

  return (
    <Box>
      <TextField
        label="Name"
        name="name"
        value={character.name}
        onChange={handleChange}
        fullWidth
        sx={{ mb: 2 }}
      />
      <TextField
        label="Class"
        name="class"
        value={character.class}
        onChange={handleChange}
        fullWidth
        sx={{ mb: 2 }}
      />
      <TextField
        label="Race"
        name="race"
        value={character.race}
        onChange={handleChange}
        fullWidth
        sx={{ mb: 2 }}
      />
      <TextField
        label="HP"
        name="hp"
        value={character.hp}
        onChange={handleChange}
        fullWidth
        sx={{ mb: 2 }}
      />
      <TextField
        label="AC"
        name="ac"
        value={character.ac}
        onChange={handleChange}
        fullWidth
        sx={{ mb: 2 }}
      />
      <TextField
        label="Avatar URL"
        name="avatar"
        value={character.avatar}
        onChange={handleChange}
        fullWidth
        sx={{ mb: 2 }}
      />
      <Typography variant="h6" gutterBottom>Stats</Typography>
      {['str', 'dex', 'int', 'cha', 'sta', 'con', 'per'].map(stat => (
        <TextField
          key={stat}
          label={stat.toUpperCase()}
          name={stat}
          value={character.stats[stat] || ''}
          onChange={handleStatChange}
          fullWidth
          sx={{ mb: 2 }}
        />
      ))}
      <Typography variant="h6" gutterBottom>Skills</Typography>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <InputLabel>Skills</InputLabel>
        <Select
          multiple
          value={selectedItems.skills}
          onChange={(e) => handleSelectChange(e, 'skills')}
          renderValue={(selected) => selected.map(item => item.name).join(', ')}
        >
          {lists.skills.map((skill) => (
            <MenuItem key={skill.id} value={skill}>
              {skill.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      {/* Repeat the above FormControl block for each type: senses, languages, damageResistance, magicResistance, spellcasting, abilities, actions, reactions */}
      <Button variant="contained" color="primary" onClick={handleSubmit}>
        Create Character
      </Button>
    </Box>
  );
};

export default CharacterForm;
