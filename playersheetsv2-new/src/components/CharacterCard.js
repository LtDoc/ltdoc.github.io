// src/components/CharacterCard.js

import React from 'react';
import { Card, CardContent, CardMedia, Typography, Box, Grid, Divider } from '@mui/material';

const CharacterCard = ({ character }) => {
  const renderStat = (label, value) => (
    <Grid item xs={4} key={label}>
      <Typography variant="body1"><strong>{label}</strong>: {value}</Typography>
    </Grid>
  );

  return (
    <Card sx={{ maxWidth: 345, margin: 'auto', mt: 3, backgroundColor: '#2E3B55', color: '#FFFFFF' }}>
      <CardContent>
        <Box display="flex" alignItems="center">
          <CardMedia
            component="img"
            sx={{ width: 80, height: 80, borderRadius: '50%', marginRight: 2 }}
            image={character.avatar || 'default-avatar.png'} // Placeholder for default avatar
            alt="Avatar"
          />
          <Typography component="div" variant="h5">{character.name}</Typography>
        </Box>
        <Typography variant="subtitle1" color="text.secondary">Class: {character.class}</Typography>
        <Typography variant="subtitle1" color="text.secondary">Race: {character.race}</Typography>
        <Typography variant="subtitle1" color="text.secondary"><span className="icon-heart">❤</span> {character.hp}</Typography>
        <Typography variant="subtitle1" color="text.secondary"><span className="icon-shield">🛡</span> {character.ac}</Typography>
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Stats</Typography>
        <Grid container spacing={2}>
          {character.stats && Object.entries(character.stats).map(([key, value]) => renderStat(key.toUpperCase(), value))}
        </Grid>
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Skills</Typography>
        {character.skills ? character.skills.map((skill, index) => (
          <Typography key={index} variant="body2">{skill.name}</Typography>
        )) : <Typography variant="body2">No skills available</Typography>}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Senses</Typography>
        {character.senses ? character.senses.map((sense, index) => (
          <Typography key={index} variant="body2">{sense.name}</Typography>
        )) : <Typography variant="body2">No senses available</Typography>}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Languages</Typography>
        {character.languages ? character.languages.map((language, index) => (
          <Typography key={index} variant="body2">{language.name}</Typography>
        )) : <Typography variant="body2">No languages available</Typography>}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Damage Resistances</Typography>
        {character.damageResistance ? character.damageResistance.map((resistance, index) => (
          <Typography key={index} variant="body2">{resistance.name}</Typography>
        )) : <Typography variant="body2">No damage resistances available</Typography>}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Magic Resistances</Typography>
        {character.magicResistance ? character.magicResistance.map((resistance, index) => (
          <Typography key={index} variant="body2">{resistance.name}</Typography>
        )) : <Typography variant="body2">No magic resistances available</Typography>}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Spellcasting</Typography>
        {character.spellcasting ? character.spellcasting.map((spell, index) => (
          <Typography key={index} variant="body2">{spell.name}</Typography>
        )) : <Typography variant="body2">No spellcasting available</Typography>}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Abilities</Typography>
        {character.abilities ? character.abilities.map((ability, index) => (
          <Typography key={index} variant="body2">{ability.name}</Typography>
        )) : <Typography variant="body2">No abilities available</Typography>}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Actions</Typography>
        {character.actions ? character.actions.map((action, index) => (
          <Typography key={index} variant="body2">{action.name}</Typography>
        )) : <Typography variant="body2">No actions available</Typography>}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Reactions</Typography>
        {character.reactions ? character.reactions.map((reaction, index) => (
          <Typography key={index} variant="body2">{reaction.name}</Typography>
        )) : <Typography variant="body2">No reactions available</Typography>}
        
        <Divider sx={{ my: 2 }} />
        
        <Typography variant="h6">Equipment/Items</Typography>
        {character.items ? character.items.map((item, index) => (
          <Typography key={index} variant="body2">{item.name}</Typography>
        )) : <Typography variant="body2">No items available</Typography>}
      </CardContent>
    </Card>
  );
};

export default CharacterCard;
