"use client";

import Image from "next/image";
import mark from "../assets/tadaima-mark.png";
import { WipeLink } from "./PageWipe";
import { IsoRoomGallery, type GalleryRoom } from "./IsoRoomGallery";
import "./RoomsPage.css";

export type RoomsPageRoom = GalleryRoom;

/** The rooms screen: a frame around the room gallery, with scanning one step away. */
export function RoomsPage({ rooms, scanHref = "/capture" }: { rooms: RoomsPageRoom[]; scanHref?: string }) {
  return (
    <main className="rooms-page">
      <header className="rooms-page__header">
        <WipeLink href="/" className="rooms-page__wordmark" aria-label="tadaima home">
          <Image src={mark} alt="" className="rooms-page__mark" priority />
          tadaima
        </WipeLink>
        <p className="rooms-page__heading">Your rooms</p>
        <nav className="rooms-page__nav" aria-label="Rooms">
          <WipeLink href="/#how" className="rooms-page__link">
            How it works
          </WipeLink>
          <WipeLink href={scanHref} className="rooms-page__link">
            Scan
          </WipeLink>
          <WipeLink href="/dev" className="rooms-page__link">
            Basket
          </WipeLink>
        </nav>
      </header>

      <div className="rooms-page__stage">
        <IsoRoomGallery rooms={rooms} hrefFor={(room) => `/rooms/${room.id}`} className="rooms-page__gallery" />
        <div className="rooms-page__light" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>

      <footer className="rooms-page__footer">
        <WipeLink href={scanHref} className="rooms-page__scan">
          <span className="rooms-page__scan-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
              <path d="M8 15.5 12 13l4 2.5M8 15.5V10l4-2.5 4 2.5v5.5M12 13V7.5" />
            </svg>
          </span>
          <span>Scan a room</span>
        </WipeLink>
        <p className="rooms-page__note">Or step into one of ours. Every piece is at its real size.</p>
      </footer>
    </main>
  );
}
