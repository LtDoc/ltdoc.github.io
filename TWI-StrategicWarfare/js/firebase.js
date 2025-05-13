// js/firebase.js

// Your existing config—keep the same databaseURL
const firebaseConfig = {
    apiKey:            "AIzaSyCo9QPVrLCXS6li_kcTu3e-GOoiiwpHvLs",
    authDomain:        "woe-world.firebaseapp.com",
    databaseURL:       "https://woe-world-default-rtdb.firebaseio.com",
    projectId:         "woe-world",
    storageBucket:     "woe-world.appspot.com",
    messagingSenderId: "706865712365",
    appId:             "1:706865712365:web:e080b1ef45b8d8b27190e4",
    measurementId:     "G-789BN2WECG"
  };
  
  // Initialize the compat SDK
  firebase.initializeApp(firebaseConfig);
  
  // Export the compat Database & Storage instances
  export const db      = firebase.database();
  export const storage = firebase.storage();
  
  /**
   * Upload a file to Storage and return its download URL.
   */
  export async function uploadFile(path, file) {
    const ref = storage.ref(path);
    await ref.put(file);                 // returns an UploadTask
    return await ref.getDownloadURL();   // promise<string>
  }
  