import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MusicCategory, SmartTrack } from "./services/music";
import { asRecord, safeStateStorage } from "./services/persistedState";
import {
  restoreMusicFeedback,
  type MusicFeedback,
} from "./services/musicRanking";

interface MusicPreferenceState {
  feedback: MusicFeedback[];
  recentIds: string[];
  rateTrack: (
    track: SmartTrack,
    category: MusicCategory,
    rating: MusicFeedback["rating"],
  ) => void;
  removeFeedback: (id: string) => void;
  clearFeedback: () => void;
  rememberTrack: (id: string) => void;
}

export const useMusicPreferenceStore = create<MusicPreferenceState>()(
  persist(
    (set) => ({
      feedback: [],
      recentIds: [],
      rateTrack: (track, category, rating) =>
        set((state) => ({
          feedback: restoreMusicFeedback([
            ...(state.feedback.find((item) => item.id === track.id)?.rating ===
            rating
              ? []
              : [
                  {
                    id: track.id,
                    title: track.title,
                    artist: track.artist,
                    category,
                    rating,
                    updatedAt: new Date().toISOString(),
                  },
                ]),
            ...state.feedback.filter((item) => item.id !== track.id),
          ]),
        })),
      removeFeedback: (id) =>
        set((state) => ({
          feedback: state.feedback.filter((item) => item.id !== id),
        })),
      clearFeedback: () => set({ feedback: [], recentIds: [] }),
      rememberTrack: (id) =>
        set((state) =>
          !/^(audius-|local-)[A-Za-z0-9_-]{1,128}$/.test(id) ||
          state.recentIds[state.recentIds.length - 1] === id
            ? state
            : {
                recentIds: [
                  ...state.recentIds.filter((item) => item !== id),
                  id,
                ].slice(-30),
              },
        ),
    }),
    {
      name: "daymate-music-feedback-v1",
      storage: safeStateStorage(() => window.localStorage),
      partialize: ({ feedback }) => ({ feedback }),
      merge: (persisted, current) => ({
        ...current,
        feedback: restoreMusicFeedback(asRecord(persisted)?.feedback),
        recentIds: [],
      }),
    },
  ),
);
