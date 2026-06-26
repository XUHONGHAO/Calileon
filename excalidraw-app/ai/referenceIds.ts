let nextReferenceIdSequence = 0;

export const createAIReferenceId = () => {
  nextReferenceIdSequence = (nextReferenceIdSequence + 1) % 1000;

  return Date.now() * 1000 + nextReferenceIdSequence;
};
