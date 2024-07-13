// src/components/DiceRoller.js
import React from 'react';
import { Button, Box } from '@mui/material';

const DiceRoller = () => {
  const rollDice = (sides) => {
    return Math.floor(Math.random() * sides) + 1;
  };

  return (
    <Box>
      <Button onClick={() => alert(`Rolled a 1d4: ${rollDice(4)}`)} variant="outlined">Roll 1d4</Button>
      <Button onClick={() => alert(`Rolled a 1d6: ${rollDice(6)}`)} variant="outlined">Roll 1d6</Button>
      <Button onClick={() => alert(`Rolled a 1d8: ${rollDice(8)}`)} variant="outlined">Roll 1d8</Button>
      <Button onClick={() => alert(`Rolled a 1d10: ${rollDice(10)}`)} variant="outlined">Roll 1d10</Button>
      <Button onClick={() => alert(`Rolled a 1d12: ${rollDice(12)}`)} variant="outlined">Roll 1d12</Button>
      <Button onClick={() => alert(`Rolled a 1d20: ${rollDice(20)}`)} variant="outlined">Roll 1d20</Button>
    </Box>
  );
};

export default DiceRoller;
