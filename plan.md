# Practice Timer

This is a web application to be used to time music practice sessions and how
time is spent inside a single practice session. It should also keep a record
of each practice session, the intervals practiced in that session along with
the date and description for that session.

## Work flow

The work flow is divided into session definition and session run phases.

## Session start

A session is started with no intervals defined. The session must be given a
name and have a date, which is defaulted to today's date with the possibility
of adjusting the date through buttons. Alternately, the user should be able to
search for previous sessions to use as a template. Once, the session name and date are set,
the user can then define intervals by entering a duration in minutes an
optional description for the interval. The user should be able to save the
session definition at any point. The user can also modify, add, and delete
existing intervals in the session. Once the user is satisfied with the definition
of the session they can save it and press "Start" to start he session. The
application should save the session definition as a template for future use.

## Session run

When a session is started, the clock starts counting down the first defined
interval. While an interval is running, the user and pause and restart the
timer. The user can also move to the next interval or return to the previous
interval by pressing a button. In either case, the time should show the
last time that was recorded by that interval. During this time, the interval
description can be changed. If this is done, the session template should be
duplicated and updated with the new description.

### Timer countdown

When an interval starts the timer should start counting down from the defined
starting point. Use a '-' in front of the time to indicate countdown. When the timer reaches
zero, it should start counting up from zero, showing a '+' to indicate this. This
count up should continue until the user presses the button to move to the next
interval.

### Saving session and interval information

The software should create a record of when each session was done and for each
interval how much time was spent on that interval, including any time after the
defined interval time. It must be possible to reconstruct a session including
the date it happened, the intervals that were recorded and their times, and a
summary of the total session time.

### Ending a session

There should be a button the directly ends the session. This ends the session,
records any data, and returns to the start.

## Technology choices

This should be a web app. If needed, minimal frameworks can be used, but there
is a strong preference for using just HTML, CSS, and glue Javascript to
construct the application. This need not be a single-page application as round
trips to the server will be cheap. The GUI should work both on a monitor and on
a mobile device like the Samsung Galaxy S23. Sqlite should be used for the
database.

## Future expansion

This section describes things that should not be implemented right now, but must
be considered in the implemtation.

In a future version, intervals will be tied to tunes. Where a tune may be an
etude or exercise, a piece being learned, or a learned piece (repertoire). Each
tune should have an author/composer, a text description of the source of the
piece and one or more URLs that point to study material and sheet music.

Sessions will then tie pieces to practice so the user can track how much and
when a certain piece was practiced or learned. It should be possible to move a
tune between exercises, learning pieces, and repertoire at any time.
