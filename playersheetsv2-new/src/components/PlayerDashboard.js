// src/components/PlayerDashboard.js

import React from 'react';
import { useLocation } from 'react-router-dom';
import { Box, Typography, Card, CardContent } from '@mui/material';

const PlayerDashboard = () => {
  const location = useLocation();
  const user = location.state.user;
  const character = Object.values(user.characters)[0]; // Assuming one character for now

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Welcome, {user.username}</Typography>
      <Card>
        <CardContent>
          <Typography variant="h5">{character.name}</Typography>
          <Typography>Class: {character.class}</Typography>
          <Typography>Race: {character.race}</Typography>
          <Typography>Challenge: {character.challenge}</Typography>
          <Typography>HP: {character.hp}</Typography>
          <Typography>AC: {character.ac}</Typography>
          <Typography>STR: {character.stats.str}</Typography>
          <Typography>DEX: {character.stats.dex}</Typography>
          <Typography>INT: {character.stats.int}</Typography>
          <Typography>CHA: {character.stats.cha}</Typography>
          <Typography>STA: {character.stats.sta}</Typography>
          <Typography>CON: {character.stats.con}</Typography>
          <Typography>PER: {character.stats.per}</Typography>
        </CardContent>
      </Card>
    </Box>
  );
};

export default PlayerDashboard;
