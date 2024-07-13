import React, { useState, useEffect } from 'react';
import { getDatabase, ref, get, child, push, update } from 'firebase/database';
import { Box, Typography, TextField, Button, Select, MenuItem, FormControl, InputLabel } from '@mui/material';

const AdminListManagement = () => {
  const [selectedList, setSelectedList] = useState('');
  const [items, setItems] = useState([]);
  const [newItem, setNewItem] = useState({});

  useEffect(() => {
    const fetchItems = async () => {
      if (selectedList) {
        const dbRef = ref(getDatabase());
        const snapshot = await get(child(dbRef, selectedList));
        if (snapshot.exists()) {
          setItems(Object.entries(snapshot.val()).map(([id, item]) => ({ id, ...item })));
        } else {
          setItems([]);
        }
      }
    };

    fetchItems();
  }, [selectedList]);

  const handleListChange = (event) => {
    setSelectedList(event.target.value);
  };

  const handleNewItemChange = (event) => {
    const { name, value } = event.target;
    setNewItem(prevState => ({ ...prevState, [name]: value }));
  };

  const handleAddItem = async () => {
    const dbRef = ref(getDatabase());
    const newItemRef = push(child(dbRef, selectedList));
    await update(newItemRef, newItem);
    setItems([...items, { id: newItemRef.key, ...newItem }]);
    setNewItem({});
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Manage Lists</Typography>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <InputLabel id="list-select-label">Select List</InputLabel>
        <Select
          labelId="list-select-label"
          value={selectedList}
          onChange={handleListChange}
        >
          <MenuItem value=""><em>None</em></MenuItem>
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
      {selectedList && (
        <Box>
          <Typography variant="h6" gutterBottom>Add New Item to {selectedList}</Typography>
          <TextField
            label="Name"
            name="name"
            value={newItem.name || ''}
            onChange={handleNewItemChange}
            fullWidth
            sx={{ mb: 2 }}
          />
          <TextField
            label="Description"
            name="desc"
            value={newItem.desc || ''}
            onChange={handleNewItemChange}
            fullWidth
            sx={{ mb: 2 }}
          />
          {['spellcasting', 'abilities', 'actions'].includes(selectedList) && (
            <TextField
              label="Level"
              name="level"
              value={newItem.level || ''}
              onChange={handleNewItemChange}
              fullWidth
              sx={{ mb: 2 }}
            />
          )}
          <Button variant="contained" color="primary" onClick={handleAddItem}>
            Add Item
          </Button>
          <Box mt={4}>
            <Typography variant="h6">Current Items in {selectedList}</Typography>
            {items.map((item) => (
              <Box key={item.id} sx={{ mb: 2 }}>
                <Typography variant="body1"><strong>Name:</strong> {item.name}</Typography>
                <Typography variant="body1"><strong>Description:</strong> {item.desc}</Typography>
                {item.level && <Typography variant="body1"><strong>Level:</strong> {item.level}</Typography>}
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default AdminListManagement;
