from django.db import models

class Habit(models.Model):
    text = models.CharField(max_length=200) # length of text
    date_added = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.text    # return string representation of the text attribute
