// src/components/AdminListManagement.js

import React, { useState, useEffect } from 'react';
import { getDatabase, ref, child, get, push, update } from 'firebase/database';
import { Box, Typography, TextField, Grid, Button, MenuItem, Select, FormControl, InputLabel } from '@mui/material';

const AdminListManagement = () => {
  const [listType, setListType] = useState('skills');
  const [listItems, setListItems] = useState([]);
  const [newItem, setNewItem] = useState({ name: '', desc: '', level: '' });

  useEffect(() => {
    const fetchListItems = async () => {
      const dbRef = ref(getDatabase());
      const snapshot = await get(child(dbRef, listType));
      if (snapshot.exists()) {
        setListItems(Object.entries(snapshot.val()).map(([id, item]) => ({ id, ...item })));
      } else {
        setListItems([]);
      }
    };

    fetchListItems();
  }, [listType]);

  const handleListTypeChange = (event) => {
    setListType(event.target.value);
    setNewItem({ name: '', desc: '', level: '' });
  };

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setNewItem((prevItem) => ({ ...prevItem, [name]: value }));
  };

  const addItem = async () => {
    const dbRef = ref(getDatabase());
    const newItemRef = push(child(dbRef, listType));
    await update(newItemRef, newItem);
    setListItems((prevItems) => [...prevItems, { id: newItemRef.key, ...newItem }]);
    setNewItem({ name: '', desc: '', level: '' });
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Admin List Management</Typography>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <InputLabel id="list-type-select-label">Select List Type</InputLabel>
        <Select labelId="list-type-select-label" value={listType} onChange={handleListTypeChange}>
          <MenuItem value="skills">Skills</MenuItem>
          <MenuItem value="senses">Senses</MenuItem>
          <MenuItem value="languages">Languages</MenuItem>
          <MenuItem value="damageResistance">Damage Resistance</MenuItem>
          <MenuItem value="magicResistance">Magic Resistance</MenuItem>
          <MenuItem value="spellcasting">Spellcasting</MenuItem>
          <MenuItem value="abilities">Abilities</MenuItem>
          <MenuItem value="actions">Actions</MenuItem>
          <MenuItem value="reactions">Reactions</MenuItem>
        </Select>
      </FormControl>
      <Grid container spacing={2}>
        <Grid item xs={4}>
          <TextField
            label="Name"
            name="name"
            value={newItem.name}
            onChange={handleInputChange}
            fullWidth
            sx={{ mb: 2 }}
          />
        </Grid>
        <Grid item xs={4}>
          <TextField
            label="Description"
            name="desc"
            value={newItem.desc}
            onChange={handleInputChange}
            fullWidth
            sx={{ mb: 2 }}
          />
        </Grid>
        {['spellcasting', 'abilities', 'actions'].includes(listType) && (
          <Grid item xs={4}>
            <TextField
              label="Level"
              name="level"
              value={newItem.level}
              onChange={handleInputChange}
              fullWidth
              sx={{ mb: 2 }}
            />
          </Grid>
        )}
        <Grid item xs={12}>
          <Button variant="contained" color="primary" onClick={addItem}>
            Add Item
          </Button>
        </Grid>
      </Grid>
      <Typography variant="h6" gutterBottom>Items</Typography>
      {listItems.map((item) => (
        <Box key={item.id} sx={{ mb: 2 }}>
          <Typography>Name: {item.name}</Typography>
          <Typography>Description: {item.desc}</Typography>
          {item.level && <Typography>Level: {item.level}</Typography>}
        </Box>
      ))}
    </Box>
  );
};

export default AdminListManagement;
