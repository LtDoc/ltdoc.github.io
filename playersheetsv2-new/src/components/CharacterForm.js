// src/components/CharacterForm.js

import React, { useState } from 'react';
import { getDatabase, ref, push, update } from 'firebase/database';
import { Box, TextField, Button, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';

const CharacterForm = ({ userId }) => {
  const [character, setCharacter] = useState({
    name: '',
    class: '',
    race: '',
    challenge: '',
    hp: '',
    ac: '',
    stats: {
      str: '',
      dex: '',
      int: '',
      cha: '',
      sta: '',
      con: '',
      per: ''
    },
    skills: [],
    senses: [],
    languages: [],
    damageResistance: [],
    magicResistance: [],
    spellcasting: [],
    abilities: [],
    actions: [],
    reactions: []
  });
  const navigate = useNavigate();

  const handleChange = (e) => {
    const { name, value } = e.target;
    setCharacter(prevState => ({ ...prevState, [name]: value }));
  };

  const handleStatChange = (e) => {
    const { name, value } = e.target;
    setCharacter(prevState => ({ ...prevState, stats: { ...prevState.stats, [name]: value } }));
  };

  const handleSubmit = async () => {
    try {
      const db = getDatabase();
      const newCharacterRef = push(ref(db, `users/${userId}/characters`));
      await update(newCharacterRef, character);
      navigate('/player');
    } catch (error) {
      console.error('Error creating character:', error);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 4 }}>
      <Typography variant="h4" gutterBottom>
        Create Character
      </Typography>
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
        label="Challenge"
        name="challenge"
        value={character.challenge}
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
      <Typography variant="h6" gutterBottom>Stats</Typography>
      {Object.entries(character.stats).map(([key, value]) => (
        <TextField
          key={key}
          label={key.toUpperCase()}
          name={key}
          value={value}
          onChange={handleStatChange}
          fullWidth
          sx={{ mb: 2 }}
        />
      ))}
      <Button variant="contained" color="primary" onClick={handleSubmit}>
        Create Character
      </Button>
    </Box>
  );
};

export default CharacterForm;
