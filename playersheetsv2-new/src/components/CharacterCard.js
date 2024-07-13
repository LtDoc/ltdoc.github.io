import React from 'react';
import { Card, CardContent, Typography, Box, Grid, Divider } from '@mui/material';

const CharacterCard = ({ character }) => {
  if (!character) return null;

  const renderStat = (label, value) => (
    <Grid item xs={4} key={label}>
      <Typography variant="body1"><strong>{label}</strong>: {value}</Typography>
    </Grid>
  );

  return (
    <Card sx={{ backgroundColor: '#d4d1c4', color: '#000', maxWidth: 800, margin: 'auto', mt: 3 }}>
      <CardContent>
        <Typography variant="h5" gutterBottom>{character.name}</Typography>
        <Typography variant="subtitle1" gutterBottom>Class: {character.class}</Typography>
        <Typography variant="subtitle1" gutterBottom>Race: {character.race}</Typography>
        <Typography variant="subtitle1" gutterBottom>Challenge: {character.challenge}</Typography>
        <Typography variant="subtitle1" gutterBottom>HP: {character.hp}</Typography>
        <Typography variant="subtitle1" gutterBottom>AC: {character.ac}</Typography>
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Stats</Typography>
        <Grid container spacing={2}>
          {Object.entries(character.stats).map(([key, value]) => renderStat(key.toUpperCase(), value))}
        </Grid>
        
        {['skills', 'senses', 'languages', 'damageResistance', 'magicResistance', 'spellcasting', 'abilities', 'actions', 'reactions', 'items'].map(category => (
          <Box key={category}>
            <Divider sx={{ my: 2 }} />
            <Typography variant="h6">{category.charAt(0).toUpperCase() + category.slice(1)}</Typography>
            {character[category]?.map((item, index) => (
              <Typography key={index} variant="body2">{item.name}: {item.desc || ''}</Typography>
            ))}
          </Box>
        ))}
        
      </CardContent>
    </Card>
  );
};

export default CharacterCard;
