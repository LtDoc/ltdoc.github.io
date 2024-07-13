// src/App.js
import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import CharacterForm from './components/CharacterForm';
import CharacterCard from './components/CharacterCard';
import AdminDashboard from './components/AdminDashboard';
import DiceRoller from './components/DiceRoller';
import Home from './components/Home';
import Login from './components/Login';
import Register from './components/Register';
import ProtectedRoute from './components/ProtectedRoute';
import { Container, Typography } from '@mui/material';
import { getDatabase, ref, get, child } from 'firebase/database';

function App() {
  const [characters, setCharacters] = useState([]);

  useEffect(() => {
    const fetchCharacters = async () => {
      const dbRef = ref(getDatabase());
      const snapshot = await get(child(dbRef, 'characters'));
      if (snapshot.exists()) {
        setCharacters(Object.values(snapshot.val()));
      } else {
        console.log("No data available");
      }
    };

    fetchCharacters();
  }, []);

  const addCharacter = (character) => {
    setCharacters([...characters, character]);
  };

  const updateCharacter = (updatedCharacter) => {
    setCharacters((prevCharacters) =>
      prevCharacters.map((char) =>
        char.id === updatedCharacter.id ? updatedCharacter : char
      )
    );
  };

  return (
    <Router>
      <Container>
        <Typography variant="h3" align="center" gutterBottom>Character Manager</Typography>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/character-form" element={<CharacterForm addCharacter={addCharacter} />} />
          <ProtectedRoute path="/admin" element={<AdminDashboard characters={characters} updateCharacter={updateCharacter} />} />
        </Routes>
        {characters.map((character) => (
          <CharacterCard key={character.id} character={character} />
        ))}
        <DiceRoller />
      </Container>
    </Router>
  );
}

export default App;
