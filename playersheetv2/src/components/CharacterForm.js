// src/components/CharacterForm.js
import React, { useState } from 'react';
import { ref, set } from 'firebase/database';
import { database } from '../firebase';
import { TextField, Button, Grid, Typography, Box } from '@mui/material';

const CharacterForm = ({ addCharacter }) => {
  const [title, setTitle] = useState('');
  const [characterClass, setCharacterClass] = useState('');
  const [race, setRace] = useState('');
  const [challenge, setChallenge] = useState('');
  const [hp, setHp] = useState('');
  const [ac, setAc] = useState('');
  const [stats, setStats] = useState({ str: '', dex: '', int: '', cha: '', sta: '', con: '', per: '' });
  const [image, setImage] = useState('');
  const [error, setError] = useState(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!title || !characterClass || !race || !challenge || !hp || !ac) {
      setError('Please fill in all required fields.');
      return;
    }

    const characterId = generateUniqueId();
    const newCharacter = {
      id: characterId,
      title,
      characterClass,
      race,
      challenge,
      hp,
      ac,
      stats,
      image,
    };

    set(ref(database, 'characters/' + characterId), newCharacter)
      .then(() => {
        clearForm();
        addCharacter(newCharacter);
        setError(null);
      })
      .catch((error) => {
        setError('Failed to save character: ' + error.message);
      });
  };

  const generateUniqueId = () => {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
  };

  const clearForm = () => {
    setTitle('');
    setCharacterClass('');
    setRace('');
    setChallenge('');
    setHp('');
    setAc('');
    setStats({ str: '', dex: '', int: '', cha: '', sta: '', con: '', per: '' });
    setImage('');
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ mt: 3 }}>
      <Typography variant="h4" gutterBottom>Character Form</Typography>
      {error && (
        <Typography color="error" variant="body2" gutterBottom>{error}</Typography>
      )}
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <TextField label="Title" fullWidth value={title} onChange={(e) => setTitle(e.target.value)} required />
        </Grid>
        <Grid item xs={12}>
          <TextField label="Class" fullWidth value={characterClass} onChange={(e) => setCharacterClass(e.target.value)} required />
        </Grid>
        <Grid item xs={12}>
          <TextField label="Race" fullWidth value={race} onChange={(e) => setRace(e.target.value)} required />
        </Grid>
        <Grid item xs={12}>
          <TextField label="Challenge" fullWidth value={challenge} onChange={(e) => setChallenge(e.target.value)} required />
        </Grid>
        <Grid item xs={12}>
          <TextField label="HP" fullWidth value={hp} onChange={(e) => setHp(e.target.value)} required />
        </Grid>
        <Grid item xs={12}>
          <TextField label="AC" fullWidth value={ac} onChange={(e) => setAc(e.target.value)} required />
        </Grid>
        <Grid item xs={12}>
          <Grid container spacing={2}>
            {['str', 'dex', 'int', 'cha', 'sta', 'con', 'per'].map(stat => (
              <Grid item xs={4} key={stat}>
                <TextField
                  label={stat.toUpperCase()}
                  value={stats[stat]}
                  onChange={(e) => setStats({ ...stats, [stat]: e.target.value })}
                  fullWidth
                  required
                />
              </Grid>
            ))}
          </Grid>
        </Grid>
        <Grid item xs={12}>
          <TextField label="Image URL" fullWidth value={image} onChange={(e) => setImage(e.target.value)} />
        </Grid>
        <Grid item xs={12}>
          <Button type="submit" variant="contained" color="primary">
            Save Character
          </Button>
        </Grid>
      </Grid>
    </Box>
  );
};

export default CharacterForm;
