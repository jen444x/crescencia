from django.db import models

class Area(models.Model):
    name = models.CharField(max_length=50) # length of name

    def __str__(self):
        return self.name    # return string representation of the name attribute

class Habit(models.Model):
    area = models.ForeignKey(Area, on_delete=models.SET_NULL, null=True)
    name = models.CharField(max_length=200) # length of name
    notes = models.TextField(blank=True)
    date_added = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.name}"
    
    
    