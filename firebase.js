const SDK_VERSION = "11.10.0";
const SDK = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
let db;
let user;
let firestore;

export async function initializeCloud() {
  const { firebaseConfig } = await import("./firebase-config.js");
  if (Object.values(firebaseConfig).some(value => !value || value.startsWith("YOUR_"))) {
    throw new Error("Add your Firebase web app settings in firebase-config.js.");
  }

  const [appSdk, authSdk, firestoreSdk] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`)
  ]);
  const app = appSdk.initializeApp(firebaseConfig);
  const auth = authSdk.getAuth(app);
  db = firestoreSdk.getFirestore(app);
  firestore = firestoreSdk;
  user = (await authSdk.signInAnonymously(auth)).user;
}

export async function saveScore(score) {
  if (!db || !user || !firestore) throw new Error("Firebase is not connected.");

  const { doc, runTransaction, serverTimestamp } = firestore;
  const entryId = `${score.nick}_${score.difficulty}`;
  const ref = doc(db, "leaderboard", entryId);
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    const previous = snapshot.exists() ? snapshot.data() : null;
    if (previous && previous.uid !== user.uid) {
      throw new Error("That nickname is already used for this difficulty. Choose another nickname.");
    }

    transaction.set(ref, {
      uid: user.uid,
      nick: score.nick,
      difficulty: score.difficulty,
      best: previous ? Math.max(previous.best, score.score) : score.score,
      plays: previous ? previous.plays + 1 : 1,
      domain: score.domain,
      updated: serverTimestamp()
    });
  });
}

export async function getLeaderboard() {
  if (!db || !firestore) throw new Error("Firebase is not connected.");

  const { collection, getDocs } = firestore;
  const snapshot = await getDocs(collection(db, "leaderboard"));
  return snapshot.docs.map(entry => entry.data())
    .sort((a, b) => b.best - a.best || a.plays - b.plays);
}
