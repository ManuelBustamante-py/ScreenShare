import {
initializeApp
}
from
"https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";

import {
getFirestore
}
from
"https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";


const firebaseConfig = {

apiKey:
"AIzaSyAyLYzLXcO5ftEWDOW9nKN29KFoFgF6nLw",

authDomain:
"screen-share-15969.firebaseapp.com",

projectId:
"screen-share-15969",

storageBucket:
"screen-share-15969.firebasestorage.app",

messagingSenderId:
"953389999987",

appId:
"1:953389999987:web:2548a638967c3a9bb3c706"

};


const app =
initializeApp(
firebaseConfig
);


export const db =
getFirestore(
app
);