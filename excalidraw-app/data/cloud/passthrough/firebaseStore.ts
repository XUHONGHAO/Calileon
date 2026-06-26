/**
 * Phase 0 passthrough: Firebase collaboration persistence.
 *
 * Re-exposes today's firebase functions VERBATIM (same signatures, same
 * behavior) so the collaboration link and the Excalidraw+ export no longer
 * import `data/firebase` — or the firebase SDK — directly (decision 0001 /
 * DoD §2). The firebase SDK stays confined to `data/firebase.ts`.
 *
 * This is the "FirebaseAdapter" surface from decision 0007 §3: a verbatim
 * pass-through of the existing collaboration subset. Whether collaboration ever
 * migrates off Firestore/Storage is a future item (requirements §5.9).
 */

export {
  loadFirebaseStorage,
  isSavedToFirebase,
  saveFilesToFirebase,
  loadFilesFromFirebase,
  saveToFirebase,
  loadFromFirebase,
  saveSceneToFirebaseStorage,
} from "../../firebase";
