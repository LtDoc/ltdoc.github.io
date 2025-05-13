import { db } from './firebase.js';
import {
  ref,
  onValue,
  push,
  set,
  update,
  remove
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-database.js';

/**
 * Watch a list under `path`, calling cb(items) on every change.
 */
export function watchList(path, cb) {
  const r = ref(db, path);
  onValue(r, snap => {
    const data = snap.val() || {};
    const items = Object.entries(data).map(([id, v]) => ({
      id,
      ...v
    }));
    cb(items);
  });
}

/** One-time read */
export async function fetchOnce(path) {
  return new Promise((res, rej) => {
    onValue(
      ref(db, path),
      snap => res(snap.val()),
      { onlyOnce: true },
      rej
    );
  });
}

/** Push a new item and return its ID */
export function addItem(path, data) {
  const newRef = push(ref(db, path));
  set(newRef, data);
  return newRef.key;
}

/** Update an existing item */
export function updateItem(path, id, data) {
  update(ref(db, `${path}/${id}`), data);
}

/** Remove an item */
export function removeItem(path, id) {
  remove(ref(db, `${path}/${id}`));
}
