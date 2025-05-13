import {
    watchList,
    addItem,
    updateItem,
    removeItem,
    fetchOnce
  } from './data.js';
  
  let map, drawnItems;
  const markers = {};
  const objectMarkers = {};
  const shapes = {};
  
  export function initMap(isDev) {
    const bounds = [[0,0],[2500,3334]];
    map = L.map('map', {
      crs: L.CRS.Simple,
      maxZoom: 3,
      minZoom: -2
    });
    L.imageOverlay('assets/worldmap.png', bounds).addTo(map);
    map.fitBounds(bounds);
  
    drawnItems = new L.FeatureGroup().addTo(map);
  
    watchList('units', onUnitsChanged);
    watchList('objects', onObjectsChanged);
    watchList('drawnFeatures', onDrawnFeaturesChanged);
  
    if (isDev) {
      const drawCtrl = new L.Control.Draw({
        edit: { featureGroup: drawnItems, remove: true },
        draw: {
          polyline: true,
          polygon: false,
          rectangle: false,
          circle: false,
          marker: false,
          circlemarker: false
        }
      });
      map.addControl(drawCtrl);
      map.on(L.Draw.Event.CREATED,  onDrawCreated);
      map.on(L.Draw.Event.EDITED,   onDrawEdited);
      map.on(L.Draw.Event.DELETED,  onDrawDeleted);
    }
  }
  
  function onUnitsChanged(units) {
    // Remove old
    Object.keys(markers)
      .filter(id => !units.find(u => u.id === id))
      .forEach(id => {
        map.removeLayer(markers[id]);
        delete markers[id];
      });
    // Add/update
    units.forEach(u => {
      const { id, latlng, iconUrl } = u;
      if (markers[id]) {
        markers[id].setLatLng([latlng.lat, latlng.lng]);
      } else {
        const ico = L.icon({ iconUrl, iconSize: [32,32] });
        const m = L.marker([latlng.lat, latlng.lng], { icon: ico }).addTo(map);
        m.on('click', () => openUnitForm(u));
        markers[id] = m;
      }
    });
  }
  
  function onObjectsChanged(objects) {
    Object.keys(objectMarkers)
      .filter(id => !objects.find(o => o.id === id))
      .forEach(id => {
        map.removeLayer(objectMarkers[id]);
        delete objectMarkers[id];
      });
    objects.forEach(o => {
      const { id, latlng, name } = o;
      if (objectMarkers[id]) {
        objectMarkers[id].setLatLng([latlng.lat, latlng.lng]);
      } else {
        const m = L.marker([latlng.lat, latlng.lng]).addTo(map);
        m.bindPopup(name || '');
        objectMarkers[id] = m;
      }
    });
  }
  
  function onDrawnFeaturesChanged(features) {
    // Clear
    Object.values(shapes).forEach(l => map.removeLayer(l));
    Object.keys(shapes).forEach(k => delete shapes[k]);
    // Re-add
    features.forEach(f => {
      let layer;
      if (f.type === 'polyline') {
        layer = L.polyline(
          f.latlngs.map(pt => [pt.lat, pt.lng]),
          f.options || {}
        );
      }
      if (!layer) return;
      layer.addTo(map);
      layer.on('click', () => openDrawForm(f));
      shapes[f.id] = layer;
    });
  }
  
  function onDrawCreated(evt) {
    if (evt.layerType === 'polyline') {
      const latlngs = evt.layer
        .getLatLngs()
        .map(ll => ({ lat: ll.lat, lng: ll.lng }));
      addItem('drawnFeatures', {
        type: 'polyline',
        latlngs,
        options: evt.layer.options
      });
    }
  }
  
  function onDrawEdited(evt) {
    evt.layers.eachLayer(layer => {
      const id = layer.feature?.id;
      if (!id) return;
      const latlngs = layer
        .getLatLngs()
        .map(ll => ({ lat: ll.lat, lng: ll.lng }));
      updateItem('drawnFeatures', id, { latlngs });
    });
  }
  
  function onDrawDeleted(evt) {
    evt.layers.eachLayer(layer => {
      const id = layer.feature?.id;
      if (id) removeItem('drawnFeatures', id);
    });
  }
  
  function openUnitForm(u) {
    // hook up your edit form if desired
  }
  
  function openDrawForm(f) {
    // hook up your edit form if desired
  }
  
  /**
   * Place a new unit from a template at the map’s current center.
   */
  export async function addUnitFromTemplate(
    templateId,
    customName,
    nationId
  ) {
    const tpl = (await fetchOnce(`unitTemplates/${templateId}`)) || {};
    const c = map.getCenter();
    const data = {
      name:    customName || tpl.name,
      nation:  nationId,
      iconUrl: tpl.iconUrl,
      attack:  tpl.attack,
      defence: tpl.defence,
      ap:      tpl.ap,
      range:   tpl.range,
      action1: tpl.action1,
      action2: tpl.action2,
      action3: tpl.action3,
      ability: tpl.ability,
      notes:   tpl.notes,
      latlng:  { lat: c.lat, lng: c.lng }
    };
    addItem('units', data);
  }
  