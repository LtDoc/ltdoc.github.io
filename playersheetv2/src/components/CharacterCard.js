// src/components/CharacterCard.js
import React from 'react';
import { Card, CardContent, CardMedia, Typography, Box, Grid, Divider } from '@mui/material';

const CharacterCard = ({ character }) => {
  const renderStat = (label, value) => (
    <Grid item xs={4}>
      <Typography variant="body1"><strong>{label}</strong>: {value}</Typography>
    </Grid>
  );

  return (
    <Card sx={{ maxWidth: 345, margin: 'auto', mt: 3 }}>
      <CardContent>
        <Box display="flex" alignItems="center">
          <CardMedia
            component="img"
            sx={{ width: 80, height: 80, borderRadius: '50%', marginRight: 2 }}
            image={character.image}
            alt="Avatar"
          />
          <Typography component="div" variant="h5">{character.title}</Typography>
        </Box>
        <Typography variant="subtitle1" color="text.secondary">Class: {character.characterClass}</Typography>
        <Typography variant="subtitle1" color="text.secondary">Level: {character.challenge}</Typography>
        <Typography variant="subtitle1" color="text.secondary"><span className="icon-heart">❤</span> {character.hp}</Typography>
        <Typography variant="subtitle1" color="text.secondary"><span className="icon-shield">🛡</span> {character.ac}</Typography>
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Stats</Typography>
        <Grid container spacing={2}>
          {Object.entries(character.stats).map(([key, value]) => renderStat(key.toUpperCase(), value))}
        </Grid>
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Skills</Typography>
        {character.skills.map((skill, index) => (
          <Typography key={index} variant="body2">{skill}</Typography>
        ))}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Senses</Typography>
        {character.senses.map((sense, index) => (
          <Typography key={index} variant="body2">{sense}</Typography>
        ))}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Languages</Typography>
        {character.languages.map((language, index) => (
          <Typography key={index} variant="body2">{language}</Typography>
        ))}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Damage Resistances</Typography>
        {character.resistances.map((resistance, index) => (
          <Typography key={index} variant="body2">{resistance}</Typography>
        ))}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Magic Resistance</Typography>
        {character.magicResistance.map((resistance, index) => (
          <Typography key={index} variant="body2">{resistance}</Typography>
        ))}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Spellcasting</Typography>
        {character.spellcasting.map((spell, index) => (
          <Typography key={index} variant="body2">{spell}</Typography>
        ))}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Abilities</Typography>
        {character.abilities.map((ability, index) => (
          <Typography key={index} variant="body2">{ability}</Typography>
        ))}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Actions</Typography>
        {character.actions.map((action, index) => (
          <Typography key={index} variant="body2">{action}</Typography>
        ))}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Reactions</Typography>
        {character.reactions.map((reaction, index) => (
          <Typography key={index} variant="body2">{reaction}</Typography>
        ))}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Equipment/Items</Typography>
        {character.items.map((item, index) => (
          <Typography key={index} variant="body2">{item}</Typography>
        ))}
        
      </CardContent>
    </Card>
  );
};

export default CharacterCard;
