// src/App.js

import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import { Container, Box, Typography, TextField, Button } from '@mui/material';
import CharacterForm from './components/CharacterForm';
import AdminDashboard from './components/AdminDashboard';
import AdminListManagement from './components/AdminListManagement';
import PlayerDashboard from './components/PlayerDashboard';
import Home from './components/Home';
import Register from './components/Register';
import ProtectedRoute from './components/ProtectedRoute';
import { getDatabase, ref, get, child } from 'firebase/database';

function App() {
  const [characters, setCharacters] = useState([]);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

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
        <Routes>
          {!isAuthenticated ? (
            <>
              <Route path="/" element={<Home setIsAuthenticated={setIsAuthenticated} setIsAdmin={setIsAdmin} />} />
              <Route path="/register" element={<Register setIsAuthenticated={setIsAuthenticated} />} />
            </>
          ) : (
            <>
              {isAdmin ? (
                <>
                  <Route path="/admin" element={
                    <ProtectedRoute isAuthenticated={isAuthenticated}>
                      <AdminDashboard characters={characters} updateCharacter={updateCharacter} />
                    </ProtectedRoute>
                  } />
                  <Route path="/admin/lists" element={<AdminListManagement />} />
                  <Route path="/" element={<Navigate to="/admin" />} />
                </>
              ) : (
                <>
                  <Route path="/player" element={<PlayerDashboard userId="exampleUserId" />} />
                  <Route path="/" element={<Navigate to="/player" />} />
                </>
              )}
              <Route path="/character-form" element={<CharacterForm addCharacter={addCharacter} />} />
            </>
          )}
        </Routes>
      </Container>
    </Router>
  );
}

export default App;
