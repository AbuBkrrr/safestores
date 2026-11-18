# Start Here — Your First Steps

Welcome. This guide assumes you have never done this before. We will go
very slowly, one small step at a time. Every word that might be
confusing gets explained the first time it shows up.

By the end of this guide, you will have the app running on your own
computer, and you'll be able to see it and click around in it. That's
the first goal. Going fully live on the internet (so other people can
use it) is a bigger goal, and we'll get to that in Part 3 — but first,
let's just see it work.

---

## Part 1 — Getting ready

### Step 1: Save the zip file somewhere you'll remember

You should have a file called something like `safe-stores-v22-FINAL.zip`.

1. Find it in your Downloads folder.
2. Move it somewhere easy to find later — for example, create a new
   folder on your Desktop called `SAFE Stores` and put the zip file
   there.

### Step 2: What is a zip file?

A zip file is like a box that many files are packed into, to make them
smaller and easier to send. Before you can use what's inside, you need
to "unzip" it (unpack the box).

**On Windows:**
1. Find the zip file.
2. Right-click on it.
3. Click "Extract All..."
4. A window pops up asking where to put the files. Just click "Extract".
5. A new folder appears with the same name, but without ".zip" at the
   end. That's your unpacked project.

**On Mac:**
1. Find the zip file.
2. Double-click it.
3. A new folder appears next to it automatically. That's your unpacked
   project.

### Step 3: Install Node.js (a required tool)

This project is written in a computer language that needs a program
called **Node.js** installed on your computer to run. Think of it like
this: your computer can open PDF files because you have a PDF reader
installed. In the same way, your computer can run this project only if
Node.js is installed.

1. Go to **nodejs.org** in your web browser.
2. You'll see a big green button. Click the one that says **LTS**
   (this means "Long Term Support" — the safe, stable version).
3. It downloads a file. Open it once it's done downloading.
4. Click "Next" through the installer, keeping everything on its
   default setting, until it finishes.
5. Restart your computer once it's done. (This step is easy to skip,
   but don't — it makes sure everything is set up correctly.)

### Step 4: What is a "terminal"?

A terminal (also called "command line" or "command prompt") is a plain
text window where you type instructions for your computer, instead of
clicking buttons. It looks intimidating at first, but you'll only ever
need to type a few exact lines we give you here — nothing more.

**On Windows:** Click the Start menu, type `PowerShell`, and open
"Windows PowerShell".

**On Mac:** Press `Cmd + Space`, type `Terminal`, and press Enter.

A black or white window opens with some text and a blinking cursor.
That's it — that's the terminal. You're ready.

---

## Part 2 — Seeing the app work on your own computer

We are going to start two things: the **backend** (the "brain" — it
stores data and handles logic) and the **frontend** (the part you
actually see and click on, in your web browser).

### Step 5: Go to the project folder in your terminal

In your terminal, type `cd ` (with a space after it), then drag the
unpacked project folder from Step 2 into the terminal window — this
automatically types the folder's location for you. Press Enter.

You should now be "inside" the project folder. To check, type:
```
dir
```
(on Windows) or
```
ls
```
(on Mac), then press Enter. You should see folder names like `backend`,
`frontend`, `desktop`, `mobile`.

### Step 6: Start the backend (the "brain")

Type these lines one at a time, pressing Enter after each one, and
waiting for it to finish before typing the next:

```
cd backend
npm install
```

This step downloads everything the backend needs. It can take a few
minutes and show a lot of text scrolling by — that's normal. Just wait
for it to stop and give you back a blinking cursor.

Next, we need to tell the backend some basic settings. Type:

**Windows:**
```
copy .env.example .env
```
**Mac:**
```
cp .env.example .env
```

This creates a settings file from a template. For now, on your own
computer, you don't need to change anything in it — the defaults work
for trying things out.

Now, for the backend to work, it needs a database (a place to store
information, like products and sales). Setting up a full database is
part of Part 3 (going live) — for now, to just SEE the app, ask
whoever is helping you technically to assist with this one step, or
skip ahead to Part 3's Step 2 when you're ready to set up a real
database. This is the only step in Part 2 that needs outside help.

### Step 7: Start the frontend (the part you see)

Open a **second** terminal window (repeat Step 4), and in that new
window:

```
cd
```
then drag the project folder in again like before, press Enter, then:

```
cd frontend
npm install
npm run dev
```

After a moment, it will print something like:
```
Local:   http://localhost:5173/
```

### Step 8: Open the app in your browser

Open your web browser (Chrome, Safari, Edge — any of them), and type
this into the address bar at the top:

```
http://localhost:5173
```

Press Enter. You should see the SAFE Stores app appear.

**Congratulations — you just ran the app on your own computer.**

---

## Part 3 — Going live (so real people can use it)

What you did in Part 2 only works on your own computer, only while
those two terminal windows stay open. "Going live" means putting the
app on the internet, on a real address, so any store owner anywhere can
use it, all the time, even when your computer is off.

This is a bigger, separate project with real costs involved (a small
monthly fee for hosting, usually $5-25) and real decisions only you can
make (which hosting company, what your bank details are, etc).

We wrote a complete, ordered guide for this exact journey — it's called
**`GO_LIVE.md`**, in the same zip file you just unpacked. It picks up
right where this guide leaves off, written the same step-by-step way,
and walks all the way through to a fully working, publicly available
app across web, desktop, and mobile.

**When you're ready for that step, open `GO_LIVE.md` next.**

---

## If something goes wrong in Part 2

- **"npm is not recognized"** — Node.js isn't installed correctly.
  Redo Step 3, and make sure you restarted your computer afterward.
- **A wall of red text appears** — don't panic. Scroll up to the very
  first red line, and share exactly that message with whoever is
  helping you technically. The very first error is almost always the
  real one; everything after it is usually just a consequence.
- **The browser says "This site can't be reached"** — check that both
  terminal windows from Steps 6 and 7 are still open and haven't shown
  any errors. If you closed either one, the app stops working until you
  start it again.
